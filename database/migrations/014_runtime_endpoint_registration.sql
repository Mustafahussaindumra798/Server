BEGIN;

ALTER TABLE public.deployments
  ADD COLUMN runtime_local_port integer,
  ADD COLUMN runtime_observed_at timestamptz,
  ADD CONSTRAINT deployments_runtime_local_port_range
    CHECK (runtime_local_port IS NULL OR runtime_local_port BETWEEN 1 AND 65535);

ALTER TABLE public.job_attempts
  ADD COLUMN result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT job_attempt_result_json_object
    CHECK (jsonb_typeof(result_json) = 'object');

-- Runtime metadata is accepted only from the node holding the active job lease.
-- The database stores only the loopback port; it is not a public endpoint.
DROP FUNCTION app_private.acknowledge_node_job(uuid,text,uuid,uuid,uuid,text,text,text);

CREATE FUNCTION app_private.acknowledge_node_job(
  p_node_id uuid,
  p_credential_hash text,
  p_job_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_status text,
  p_result_code text,
  p_result_summary text,
  p_result_json jsonb
)
RETURNS TABLE(job_id uuid, status text, attempt_id uuid, retry_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $ack_job$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_job public.jobs%ROWTYPE;
  v_next_status text;
  v_retry_at timestamptz;
BEGIN
  IF p_node_id IS NULL OR p_job_id IS NULL OR p_attempt_id IS NULL OR p_lease_token IS NULL
     OR p_credential_hash IS NULL OR p_credential_hash !~ '^[0-9a-f]{64}$'
     OR p_status IS NULL OR p_status NOT IN ('accepted', 'running', 'succeeded', 'failed', 'rejected')
     OR (p_result_code IS NOT NULL AND length(p_result_code) > 80)
     OR (p_result_summary IS NOT NULL AND length(p_result_summary) > 4000)
     OR p_result_json IS NULL OR jsonb_typeof(p_result_json) <> 'object'
     OR length(p_result_json::text) > 2048 THEN
    RAISE EXCEPTION 'Invalid job acknowledgement input' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.node_credentials AS credential
    JOIN public.nodes AS node ON node.id = credential.node_id
    WHERE node.id = p_node_id
      AND node.status <> 'revoked'
      AND credential.secret_hash = p_credential_hash
      AND credential.revoked_at IS NULL
      AND (credential.expires_at IS NULL OR credential.expires_at > v_now)
  ) THEN
    RETURN;
  END IF;

  SELECT job.* INTO v_job
  FROM public.jobs AS job
  WHERE job.id = p_job_id
    AND job.node_id = p_node_id
    AND job.active_attempt_id = p_attempt_id
    AND job.lease_token = p_lease_token
    AND job.lease_expires_at > v_now
    AND job.status IN ('leased', 'accepted', 'running')
  FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;
  IF p_status = 'accepted' AND v_job.status <> 'leased' THEN RETURN; END IF;
  IF p_status = 'running' AND v_job.status NOT IN ('leased', 'accepted') THEN RETURN; END IF;

  IF p_status IN ('succeeded', 'failed', 'rejected') THEN
    UPDATE public.job_attempts AS attempt
       SET finished_at = v_now,
           result_code = p_result_code,
           result_summary = p_result_summary,
           result_json = p_result_json
     WHERE attempt.id = p_attempt_id AND attempt.job_id = p_job_id
       AND attempt.node_id = p_node_id AND attempt.finished_at IS NULL;

    IF p_status = 'failed' AND v_job.attempt_count < v_job.max_attempts THEN
      v_next_status := 'queued';
      v_retry_at := v_now + make_interval(secs => LEAST(300, 5 * (2 ^ LEAST(v_job.attempt_count, 6))::integer));
      UPDATE public.jobs
         SET status = v_next_status, available_at = v_retry_at,
             lease_expires_at = NULL, active_attempt_id = NULL, lease_token = NULL
       WHERE id = p_job_id;
    ELSE
      v_next_status := p_status;
      UPDATE public.jobs
         SET status = v_next_status, lease_expires_at = NULL,
             active_attempt_id = NULL, lease_token = NULL
       WHERE id = p_job_id;
    END IF;
  ELSE
    v_next_status := p_status;
    UPDATE public.jobs
       SET status = v_next_status,
           lease_expires_at = v_now + interval '120 seconds'
     WHERE id = p_job_id;
  END IF;

  INSERT INTO public.audit_events (
    tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json
  ) VALUES (
    v_job.tenant_id, 'node', p_node_id, 'node.job.' || p_status,
    'job', p_job_id,
    jsonb_build_object('attempt_id', p_attempt_id, 'attempt_number', v_job.attempt_count,
                       'result_code', p_result_code)
  );

  RETURN QUERY SELECT p_job_id, v_next_status, p_attempt_id, v_retry_at;
END
$ack_job$;

REVOKE ALL ON FUNCTION app_private.acknowledge_node_job(uuid,text,uuid,uuid,uuid,text,text,text,jsonb) FROM PUBLIC;

-- Keep the original eight-argument SQL contract working for existing
-- administrative/integration callers. Node agents use the metadata-aware
-- nine-argument overload.
CREATE FUNCTION app_private.acknowledge_node_job(
  p_node_id uuid,
  p_credential_hash text,
  p_job_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_status text,
  p_result_code text,
  p_result_summary text
)
RETURNS TABLE(job_id uuid, status text, attempt_id uuid, retry_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $ack_legacy$
  SELECT * FROM app_private.acknowledge_node_job(
    p_node_id, p_credential_hash, p_job_id, p_attempt_id, p_lease_token,
    p_status, p_result_code, p_result_summary, '{}'::jsonb
  );
$ack_legacy$;

REVOKE ALL ON FUNCTION app_private.acknowledge_node_job(uuid,text,uuid,uuid,uuid,text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_private.record_deployment_runtime_endpoint()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $runtime_endpoint$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_local_port integer;
  v_port_numeric numeric;
BEGIN
  IF NEW.finished_at IS NULL OR NEW.result_code IS NULL
     OR NEW.result_code NOT IN ('workload_healthy','workload_stopped','workload_already_stopped') THEN
    RETURN NEW;
  END IF;

  SELECT job.* INTO v_job
    FROM public.jobs AS job
   WHERE job.id = NEW.job_id
     AND job.deployment_id IS NOT NULL
     AND job.node_id = NEW.node_id
     AND job.type IN ('deploy','restart','stop');

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.result_code = 'workload_healthy' THEN
    IF v_job.type NOT IN ('deploy','restart') THEN
      RETURN NEW;
    END IF;
    IF jsonb_object_length(NEW.result_json) <> 2
       OR NOT (NEW.result_json ?& ARRAY['local_port','container_name'])
       OR jsonb_typeof(NEW.result_json->'local_port') <> 'number'
       OR jsonb_typeof(NEW.result_json->'container_name') <> 'string'
       OR NEW.result_json->>'container_name' <> ('cloudexify-' || v_job.deployment_id::text) THEN
      RETURN NEW;
    END IF;

    v_port_numeric := (NEW.result_json->>'local_port')::numeric;
    IF v_port_numeric <> trunc(v_port_numeric)
       OR v_port_numeric < 1
       OR v_port_numeric > 65535 THEN
      RETURN NEW;
    END IF;
    v_local_port := v_port_numeric::integer;

    UPDATE public.deployments
       SET runtime_local_port = v_local_port,
           runtime_observed_at = NEW.finished_at,
           updated_at = clock_timestamp()
     WHERE id = v_job.deployment_id
       AND tenant_id = v_job.tenant_id
       AND target_node_id = v_job.node_id
       AND desired_state = 'running';
  ELSIF NEW.result_code IN ('workload_stopped','workload_already_stopped') THEN
    IF v_job.type <> 'stop' THEN
      RETURN NEW;
    END IF;
    UPDATE public.deployments
       SET runtime_local_port = NULL,
           runtime_observed_at = NEW.finished_at,
           updated_at = clock_timestamp()
     WHERE id = v_job.deployment_id
       AND tenant_id = v_job.tenant_id
       AND target_node_id = v_job.node_id;
  END IF;

  RETURN NEW;
END
$runtime_endpoint$;

DROP TRIGGER IF EXISTS job_attempts_record_deployment_endpoint ON public.job_attempts;
CREATE TRIGGER job_attempts_record_deployment_endpoint
AFTER UPDATE OF finished_at, result_code, result_json ON public.job_attempts
FOR EACH ROW
WHEN (NEW.finished_at IS NOT NULL AND OLD.finished_at IS NULL)
EXECUTE FUNCTION app_private.record_deployment_runtime_endpoint();

REVOKE ALL ON FUNCTION app_private.record_deployment_runtime_endpoint() FROM PUBLIC;

COMMIT;

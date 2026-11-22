BEGIN;

-- Jobs are typed requests, never shell snippets. The first agent protocol only
-- enables non-mutating diagnostics; mutating deployment actions need dedicated
-- execution adapters and additional review before they are enabled.
ALTER TABLE jobs
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN active_attempt_id uuid REFERENCES job_attempts(id) ON DELETE RESTRICT,
  ADD COLUMN lease_token uuid;

CREATE INDEX jobs_available_queue_idx
  ON jobs (node_id, available_at, created_at)
  WHERE status = 'queued';


CREATE OR REPLACE FUNCTION app_private.node_credential_is_valid(
  p_node_id uuid,
  p_credential_hash text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $credential_check$
  SELECT EXISTS (
    SELECT 1
    FROM public.node_credentials AS credential
    JOIN public.nodes AS node ON node.id = credential.node_id
    WHERE node.id = p_node_id
      AND node.status <> 'revoked'
      AND credential.secret_hash = p_credential_hash
      AND credential.revoked_at IS NULL
      AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
  )
$credential_check$;

CREATE OR REPLACE FUNCTION app_private.claim_node_jobs(
  p_node_id uuid,
  p_credential_hash text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE(
  job_id uuid,
  job_type text,
  payload jsonb,
  attempt_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_number integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $claim_jobs$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_job public.jobs%ROWTYPE;
  v_attempt_id uuid;
  v_lease_token uuid;
BEGIN
  IF p_node_id IS NULL OR p_credential_hash IS NULL
     OR p_credential_hash !~ '^[0-9a-f]{64}$'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 15 AND 300 THEN
    RAISE EXCEPTION 'Invalid job claim input' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.nodes AS node
    JOIN public.node_credentials AS credential ON credential.node_id = node.id
    WHERE node.id = p_node_id
      AND node.approved_at IS NOT NULL
      AND node.status <> 'revoked'
      AND node.last_seen_at > v_now - make_interval(secs => node.heartbeat_interval_seconds * 3)
      AND credential.secret_hash = p_credential_hash
      AND credential.revoked_at IS NULL
      AND (credential.expires_at IS NULL OR credential.expires_at > v_now)
  ) THEN
    RETURN;
  END IF;

  -- Expired leases close their attempt. Failed work is retried with bounded
  -- exponential backoff and permanently fails after max_attempts.
  FOR v_job IN
    SELECT job.*
    FROM public.jobs AS job
    WHERE job.node_id = p_node_id
      AND job.status IN ('leased', 'accepted', 'running')
      AND job.lease_expires_at <= v_now
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.job_attempts
       SET finished_at = v_now, result_code = 'lease_expired',
           result_summary = 'Agent lease expired before completion.'
     WHERE id = v_job.active_attempt_id AND finished_at IS NULL;

    UPDATE public.jobs
       SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
           available_at = v_now + make_interval(secs => LEAST(300, 5 * (2 ^ LEAST(attempt_count, 6))::integer)),
           lease_expires_at = NULL, active_attempt_id = NULL, lease_token = NULL
     WHERE id = v_job.id;
  END LOOP;

  FOR v_job IN
    SELECT job.*
    FROM public.jobs AS job
    WHERE job.node_id = p_node_id
      AND job.status = 'queued'
      AND job.available_at <= v_now
      AND job.attempt_count < job.max_attempts
    ORDER BY job.created_at, job.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  LOOP
    INSERT INTO public.job_attempts (job_id, node_id)
    VALUES (v_job.id, p_node_id)
    RETURNING id INTO v_attempt_id;

    v_lease_token := gen_random_uuid();

    UPDATE public.jobs
       SET status = 'leased',
           attempt_count = attempt_count + 1,
           active_attempt_id = v_attempt_id,
           lease_token = v_lease_token,
           lease_expires_at = v_now + make_interval(secs => p_lease_seconds)
     WHERE id = v_job.id;

    RETURN QUERY SELECT v_job.id, v_job.type, v_job.payload_json,
                        v_attempt_id, v_lease_token,
                        v_now + make_interval(secs => p_lease_seconds),
                        v_job.attempt_count + 1;
  END LOOP;
END
$claim_jobs$;

CREATE OR REPLACE FUNCTION app_private.acknowledge_node_job(
  p_node_id uuid,
  p_credential_hash text,
  p_job_id uuid,
  p_attempt_id uuid,
  p_lease_token uuid,
  p_status text,
  p_result_code text DEFAULT NULL,
  p_result_summary text DEFAULT NULL
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
     OR (p_result_summary IS NOT NULL AND length(p_result_summary) > 4000) THEN
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
    UPDATE public.job_attempts
       SET finished_at = v_now,
           result_code = p_result_code,
           result_summary = p_result_summary
     WHERE id = p_attempt_id AND job_id = p_job_id
       AND node_id = p_node_id AND finished_at IS NULL;

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

REVOKE ALL ON FUNCTION app_private.node_credential_is_valid(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.claim_node_jobs(uuid,text,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.acknowledge_node_job(uuid,text,uuid,uuid,uuid,text,text,text) FROM PUBLIC;

COMMIT;

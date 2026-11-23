BEGIN;

ALTER TABLE public.deployments
  ADD COLUMN rollback_of_deployment_id uuid
    REFERENCES public.deployments(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX deployments_one_automatic_rollback_idx
  ON public.deployments (rollback_of_deployment_id)
  WHERE rollback_of_deployment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.reconcile_deployment_job_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reconcile$
DECLARE
  v_result_code text;
  v_deployment public.deployments%ROWTYPE;
  v_previous public.deployments%ROWTYPE;
  v_application_state text;
  v_next_revision integer;
  v_rollback_id uuid;
  v_rollback_job_id uuid;
BEGIN
  IF NEW.deployment_id IS NULL OR NEW.type NOT IN ('deploy','stop','restart')
     OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'succeeded' THEN
    SELECT attempt.result_code INTO v_result_code
      FROM public.job_attempts AS attempt
     WHERE attempt.job_id = NEW.id
     ORDER BY attempt.started_at DESC
     LIMIT 1;
  END IF;

  UPDATE public.deployments AS deployment
     SET status = CASE
       WHEN NEW.type = 'deploy' AND NEW.status IN ('accepted','running') THEN 'deploying'
       WHEN NEW.type = 'deploy' AND NEW.status = 'succeeded' AND v_result_code = 'workload_healthy' THEN 'healthy'
       WHEN NEW.type = 'stop' AND NEW.status IN ('accepted','running') THEN 'stopping'
       WHEN NEW.type = 'stop' AND NEW.status = 'succeeded' AND v_result_code IN ('workload_stopped','workload_already_stopped') THEN 'stopped'
       WHEN NEW.type = 'restart' AND NEW.status IN ('accepted','running') THEN 'restarting'
       WHEN NEW.type = 'restart' AND NEW.status = 'succeeded' AND v_result_code = 'workload_healthy' THEN 'healthy'
       WHEN NEW.status IN ('failed','rejected') OR NEW.status = 'succeeded' THEN 'failed'
       ELSE deployment.status
     END,
     health_checked_at = CASE
       WHEN NEW.type IN ('deploy','restart') AND NEW.status = 'succeeded' AND v_result_code = 'workload_healthy' THEN clock_timestamp()
       ELSE deployment.health_checked_at
     END,
     updated_at = clock_timestamp()
   WHERE deployment.id = NEW.deployment_id
     AND deployment.tenant_id = NEW.tenant_id
     AND (
       (NEW.type = 'deploy' AND deployment.desired_state = 'running' AND deployment.status IN ('scheduled','deploying')) OR
       (NEW.type = 'stop' AND deployment.desired_state = 'stopped' AND deployment.status = 'stopping') OR
       (NEW.type = 'restart' AND deployment.desired_state = 'running' AND deployment.status = 'restarting')
     );

  SELECT * INTO v_deployment
    FROM public.deployments
   WHERE id = NEW.deployment_id AND tenant_id = NEW.tenant_id;

  -- A rollback revision is considered complete only after its own HTTP
  -- health check succeeds. The failed revision is then marked rolled_back.
  IF NEW.type = 'deploy' AND NEW.status = 'succeeded'
     AND v_result_code = 'workload_healthy'
     AND v_deployment.rollback_of_deployment_id IS NOT NULL THEN
    UPDATE public.deployments
       SET status = 'rolled_back', updated_at = clock_timestamp()
     WHERE id = v_deployment.rollback_of_deployment_id
       AND tenant_id = NEW.tenant_id
       AND status = 'failed'
       AND desired_state = 'running';
  END IF;

  -- Only terminal failures of ordinary deploy revisions may initiate a
  -- rollback. Retryable failures are re-queued by acknowledge_node_job().
  -- A rollback revision cannot recursively initiate another rollback.
  IF NEW.type = 'deploy'
     AND NEW.status IN ('failed','rejected')
     AND v_deployment.rollback_of_deployment_id IS NULL
     AND v_deployment.desired_state = 'running'
     AND (NEW.status = 'rejected' OR NEW.attempt_count >= NEW.max_attempts) THEN

    SELECT application.desired_state INTO v_application_state
      FROM public.applications AS application
     WHERE application.id = v_deployment.application_id
       AND application.tenant_id = v_deployment.tenant_id
     FOR UPDATE;

    IF v_application_state = 'running' THEN
      SELECT previous.* INTO v_previous
        FROM public.deployments AS previous
        JOIN public.nodes AS node
          ON node.id = previous.target_node_id
         AND node.tenant_id = previous.tenant_id
       WHERE previous.application_id = v_deployment.application_id
         AND previous.tenant_id = v_deployment.tenant_id
         AND previous.revision < v_deployment.revision
         AND previous.desired_state = 'running'
         AND previous.status = 'healthy'
         AND previous.health_checked_at IS NOT NULL
         AND previous.image_digest IS NOT NULL
         AND previous.container_port BETWEEN 1 AND 65535
         AND node.approved_at IS NOT NULL
         AND node.status IN ('online','degraded')
         AND node.last_seen_at > clock_timestamp() - make_interval(secs => node.heartbeat_interval_seconds * 3)
       ORDER BY previous.revision DESC
       LIMIT 1;

      IF v_previous.id IS NOT NULL THEN
        SELECT COALESCE(MAX(revision), 0) + 1 INTO v_next_revision
          FROM public.deployments
         WHERE application_id = v_deployment.application_id
           AND tenant_id = v_deployment.tenant_id;

        INSERT INTO public.deployments (
          tenant_id, application_id, revision, target_node_id,
          desired_state, status, created_by, image_digest, container_port,
          health_check_path, health_check_timeout_seconds,
          resource_requests_json, rollback_of_deployment_id
        ) VALUES (
          v_previous.tenant_id, v_previous.application_id, v_next_revision,
          v_previous.target_node_id, 'running', 'scheduled', v_deployment.created_by,
          v_previous.image_digest, v_previous.container_port,
          v_previous.health_check_path, v_previous.health_check_timeout_seconds,
          v_previous.resource_requests_json, v_deployment.id
        )
        ON CONFLICT (rollback_of_deployment_id)
          WHERE rollback_of_deployment_id IS NOT NULL
        DO NOTHING
        RETURNING id INTO v_rollback_id;

        IF v_rollback_id IS NOT NULL THEN
          INSERT INTO public.jobs (
            tenant_id, node_id, deployment_id, type, payload_json, idempotency_key
          ) VALUES (
            v_previous.tenant_id,
            v_previous.target_node_id,
            v_rollback_id,
            'deploy',
            jsonb_build_object(
              'deployment_id', v_rollback_id,
              'image', v_previous.image_digest,
              'container_port', v_previous.container_port,
              'health_check_path', v_previous.health_check_path,
              'health_check_timeout_seconds', v_previous.health_check_timeout_seconds,
              'resources', jsonb_build_object(
                'cpu_millicores', (v_previous.resource_requests_json->>'cpu_millicores')::integer,
                'memory_bytes', (v_previous.resource_requests_json->>'memory_bytes')::bigint,
                'disk_bytes', (v_previous.resource_requests_json->>'disk_bytes')::bigint
              )
            ),
            'deployment:' || v_rollback_id::text || ':automatic-rollback'
          )
          RETURNING id INTO v_rollback_job_id;

          INSERT INTO public.audit_events (
            tenant_id, actor_type, action, resource_type, resource_id, metadata_json
          ) VALUES (
            v_previous.tenant_id, 'system', 'deployment.rollback.queued',
            'deployment', v_rollback_id,
            jsonb_build_object(
              'failed_deployment_id', v_deployment.id,
              'rollback_source_deployment_id', v_previous.id,
              'job_id', v_rollback_job_id
            )
          );
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$reconcile$;

REVOKE ALL ON FUNCTION app_private.reconcile_deployment_job_status() FROM PUBLIC;

COMMIT;

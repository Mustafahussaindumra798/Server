BEGIN;

-- A rollback reactivates the previous immutable revision in place. This avoids
-- creating a duplicate container and double-reserving its CPU/memory/disk.
ALTER TABLE public.deployments
  ADD COLUMN rollback_attempt_for_deployment_id uuid
    REFERENCES public.deployments(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX deployments_one_automatic_rollback_attempt_idx
  ON public.deployments (rollback_attempt_for_deployment_id)
  WHERE rollback_attempt_for_deployment_id IS NOT NULL;

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

  -- The previous revision becomes the active healthy revision again only
  -- after its restart job passes the configured HTTP health check.
  IF NEW.type = 'restart' AND NEW.status = 'succeeded'
     AND v_result_code = 'workload_healthy'
     AND v_deployment.rollback_attempt_for_deployment_id IS NOT NULL THEN
    UPDATE public.deployments
       SET status = 'rolled_back', updated_at = clock_timestamp()
     WHERE id = v_deployment.rollback_attempt_for_deployment_id
       AND tenant_id = NEW.tenant_id
       AND status = 'failed'
       AND desired_state = 'running';

    UPDATE public.deployments
       SET rollback_attempt_for_deployment_id = NULL,
           updated_at = clock_timestamp()
     WHERE id = v_deployment.id
       AND tenant_id = NEW.tenant_id;
  END IF;

  -- Only terminal failures of normal deploy jobs can initiate rollback.
  -- Retryable failures are re-queued by acknowledge_node_job(); restart
  -- failures never recursively initiate another rollback.
  IF NEW.type = 'deploy'
     AND NEW.status IN ('failed','rejected')
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
         AND previous.container_port BETWEEN 1 AND 65535
         AND previous.rollback_attempt_for_deployment_id IS NULL
         AND node.approved_at IS NOT NULL
         AND node.status IN ('online','degraded')
         AND node.last_seen_at > clock_timestamp() - make_interval(secs => node.heartbeat_interval_seconds * 3)
       ORDER BY previous.revision DESC
       LIMIT 1
       FOR UPDATE OF previous;

      IF v_previous.id IS NOT NULL THEN
        UPDATE public.deployments
           SET status = 'restarting',
               rollback_attempt_for_deployment_id = v_deployment.id,
               updated_at = clock_timestamp()
         WHERE id = v_previous.id
           AND tenant_id = v_previous.tenant_id
           AND status = 'healthy'
           AND rollback_attempt_for_deployment_id IS NULL;

        IF FOUND THEN
          INSERT INTO public.jobs (
            tenant_id, node_id, deployment_id, type, payload_json, idempotency_key
          ) VALUES (
            v_previous.tenant_id,
            v_previous.target_node_id,
            v_previous.id,
            'restart',
            jsonb_build_object(
              'deployment_id', v_previous.id,
              'container_port', v_previous.container_port,
              'health_check_path', v_previous.health_check_path,
              'health_check_timeout_seconds', v_previous.health_check_timeout_seconds
            ),
            'deployment:' || v_previous.id::text || ':automatic-rollback:' || v_deployment.id::text
          )
          RETURNING id INTO v_rollback_job_id;

          INSERT INTO public.audit_events (
            tenant_id, actor_type, action, resource_type, resource_id, metadata_json
          ) VALUES (
            v_previous.tenant_id, 'system', 'deployment.rollback.queued',
            'deployment', v_previous.id,
            jsonb_build_object(
              'failed_deployment_id', v_deployment.id,
              'restored_deployment_id', v_previous.id,
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

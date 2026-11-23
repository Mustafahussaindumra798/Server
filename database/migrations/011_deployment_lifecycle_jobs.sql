BEGIN;

ALTER TABLE public.deployments
  DROP CONSTRAINT deployments_status_check,
  ADD CONSTRAINT deployments_status_check
    CHECK (status IN ('queued','scheduled','deploying','healthy','stopping','stopped','restarting','failed','rolled_back','cancelled'));

CREATE OR REPLACE FUNCTION app_private.reconcile_deployment_job_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reconcile$
DECLARE
  v_result_code text;
BEGIN
  IF NEW.deployment_id IS NULL OR NEW.type NOT IN ('deploy','stop','restart') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
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

  RETURN NEW;
END
$reconcile$;

REVOKE ALL ON FUNCTION app_private.reconcile_deployment_job_status() FROM PUBLIC;

COMMIT;

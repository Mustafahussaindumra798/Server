BEGIN;

ALTER TABLE public.deployments
  ADD COLUMN health_check_path text NOT NULL DEFAULT '/',
  ADD COLUMN health_check_timeout_seconds integer NOT NULL DEFAULT 30,
  ADD COLUMN health_checked_at timestamptz;

ALTER TABLE public.deployments
  ADD CONSTRAINT deployments_health_check_path_valid
    CHECK (length(health_check_path) BETWEEN 1 AND 256
      AND left(health_check_path, 1) = '/'
      AND health_check_path ~ '^/[A-Za-z0-9._~!AND health_check_path !~ '[[:cntrl:]]'
      AND health_check_path !~ '^//'),''()*+,;=:@%/-]*
  ADD CONSTRAINT deployments_health_check_timeout_range
    CHECK (health_check_timeout_seconds BETWEEN 5 AND 120);

CREATE OR REPLACE FUNCTION app_private.reconcile_deployment_job_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reconcile$
DECLARE
  v_result_code text;
BEGIN
  IF NEW.deployment_id IS NULL OR NEW.type <> 'deploy' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
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
       WHEN NEW.status IN ('accepted', 'running') THEN 'deploying'
       WHEN NEW.status = 'succeeded' AND v_result_code = 'workload_healthy' THEN 'healthy'
       WHEN NEW.status IN ('failed', 'rejected') THEN 'failed'
       WHEN NEW.status = 'succeeded' THEN 'failed'
       ELSE deployment.status
     END,
     health_checked_at = CASE
       WHEN NEW.status = 'succeeded' AND v_result_code = 'workload_healthy' THEN clock_timestamp()
       ELSE deployment.health_checked_at
     END,
     updated_at = clock_timestamp()
   WHERE deployment.id = NEW.deployment_id
     AND deployment.tenant_id = NEW.tenant_id
     AND deployment.desired_state = 'running'
     AND deployment.status IN ('scheduled', 'deploying');

  RETURN NEW;
END
$reconcile$;

REVOKE ALL ON FUNCTION app_private.reconcile_deployment_job_status() FROM PUBLIC;

COMMIT;

      AND health_check_path !~ '^//'
      AND health_check_path !~ '(^|/)\\.\\.(/|$)'),
  ADD CONSTRAINT deployments_health_check_timeout_range
    CHECK (health_check_timeout_seconds BETWEEN 5 AND 120);

CREATE OR REPLACE FUNCTION app_private.reconcile_deployment_job_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reconcile$
DECLARE
  v_result_code text;
BEGIN
  IF NEW.deployment_id IS NULL OR NEW.type <> 'deploy' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
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
       WHEN NEW.status IN ('accepted', 'running') THEN 'deploying'
       WHEN NEW.status = 'succeeded' AND v_result_code = 'workload_healthy' THEN 'healthy'
       WHEN NEW.status IN ('failed', 'rejected') THEN 'failed'
       WHEN NEW.status = 'succeeded' THEN 'failed'
       ELSE deployment.status
     END,
     health_checked_at = CASE
       WHEN NEW.status = 'succeeded' AND v_result_code = 'workload_healthy' THEN clock_timestamp()
       ELSE deployment.health_checked_at
     END,
     updated_at = clock_timestamp()
   WHERE deployment.id = NEW.deployment_id
     AND deployment.tenant_id = NEW.tenant_id
     AND deployment.desired_state = 'running'
     AND deployment.status IN ('scheduled', 'deploying');

  RETURN NEW;
END
$reconcile$;

REVOKE ALL ON FUNCTION app_private.reconcile_deployment_job_status() FROM PUBLIC;

COMMIT;

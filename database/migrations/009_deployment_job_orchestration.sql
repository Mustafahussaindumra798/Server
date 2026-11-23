BEGIN;

ALTER TABLE deployments
  ADD COLUMN image_digest text,
  ADD COLUMN container_port integer;

ALTER TABLE deployments
  ADD CONSTRAINT deployments_image_digest_format
    CHECK (image_digest IS NULL OR image_digest ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$'),
  ADD CONSTRAINT deployments_container_port_range
    CHECK (container_port IS NULL OR container_port BETWEEN 1 AND 65535);

CREATE OR REPLACE FUNCTION app_private.reconcile_deployment_job_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reconcile$
BEGIN
  IF NEW.deployment_id IS NULL OR NEW.type <> 'deploy' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  UPDATE public.deployments AS deployment
     SET status = CASE
       WHEN NEW.status IN ('accepted', 'running', 'succeeded') THEN 'deploying'
       WHEN NEW.status IN ('failed', 'rejected') THEN 'failed'
       ELSE deployment.status
     END,
     updated_at = clock_timestamp()
   WHERE deployment.id = NEW.deployment_id
     AND deployment.tenant_id = NEW.tenant_id
     AND deployment.desired_state = 'running'
     AND deployment.status IN ('scheduled', 'deploying');

  RETURN NEW;
END
$reconcile$;

DROP TRIGGER IF EXISTS jobs_reconcile_deployment_status ON public.jobs;
CREATE TRIGGER jobs_reconcile_deployment_status
AFTER UPDATE OF status ON public.jobs
FOR EACH ROW
EXECUTE FUNCTION app_private.reconcile_deployment_job_status();

REVOKE ALL ON FUNCTION app_private.reconcile_deployment_job_status() FROM PUBLIC;

COMMIT;

BEGIN;

-- Signed grants bind route_version and the observed loopback endpoint. Any
-- deployment target change must invalidate grants issued for the old target,
-- even when the route remains otherwise eligible (for example, a port-only
-- endpoint refresh on the same node).
CREATE OR REPLACE FUNCTION app_private.bump_deployment_domain_route_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $bump_route_version$
BEGIN
  UPDATE public.deployment_domain_routes
     SET route_version = route_version + 1
   WHERE deployment_id = OLD.id;

  RETURN NEW;
END
$bump_route_version$;

REVOKE ALL ON FUNCTION app_private.bump_deployment_domain_route_version() FROM PUBLIC;

CREATE TRIGGER deployments_bump_domain_route_target_version
  BEFORE UPDATE OF target_node_id, runtime_local_port
  ON public.deployments
  FOR EACH ROW
  WHEN (
    OLD.target_node_id IS DISTINCT FROM NEW.target_node_id
    OR OLD.runtime_local_port IS DISTINCT FROM NEW.runtime_local_port
  )
  EXECUTE FUNCTION app_private.bump_deployment_domain_route_version();

COMMIT;

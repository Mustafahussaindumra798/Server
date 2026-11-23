BEGIN;

-- Runtime ports are intentionally not persisted in the route registry.
-- Still, changing the selected loopback endpoint must invalidate grants and
-- advance the route version while preserving the active route state.
CREATE OR REPLACE FUNCTION app_private.bump_ingress_route_version_on_port_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $bump_route_version$
BEGIN
  IF OLD.runtime_local_port IS DISTINCT FROM NEW.runtime_local_port
     AND OLD.target_node_id IS NOT DISTINCT FROM NEW.target_node_id THEN
    UPDATE public.deployment_domain_routes
       SET route_version = route_version + 1
     WHERE deployment_id = NEW.id
       AND node_id = NEW.target_node_id
       AND status = 'active';
  END IF;
  RETURN NEW;
END
$bump_route_version$;

CREATE TRIGGER deployments_route_endpoint_version
  AFTER UPDATE OF runtime_local_port ON public.deployments
  FOR EACH ROW
  EXECUTE FUNCTION app_private.bump_ingress_route_version_on_port_change();

REVOKE ALL ON FUNCTION app_private.bump_ingress_route_version_on_port_change() FROM PUBLIC;

COMMIT;

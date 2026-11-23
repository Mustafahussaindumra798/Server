BEGIN;

-- This is an internal route-intent registry only. It deliberately has no
-- "active" state and stores no upstream URL, IP address or local port.
-- Public traffic remains impossible until the authenticated tunnel/gateway
-- implementation is separately qualified.
CREATE TABLE public.deployment_domain_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  domain_claim_id uuid NOT NULL,
  application_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  node_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_transport'
    CHECK (status IN ('pending_transport', 'suspended')),
  reason_code text NOT NULL
    CHECK (reason_code IN (
      'transport_not_qualified',
      'domain_not_verified',
      'tenant_not_active',
      'application_not_running',
      'deployment_not_healthy',
      'endpoint_missing_or_stale',
      'node_not_qualified'
    )),
  route_version bigint NOT NULL DEFAULT 1 CHECK (route_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_eligible_at timestamptz,
  UNIQUE (domain_claim_id),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (domain_claim_id, tenant_id)
    REFERENCES public.domain_claims(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (application_id, tenant_id)
    REFERENCES public.applications(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (deployment_id, tenant_id)
    REFERENCES public.deployments(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (node_id, tenant_id)
    REFERENCES public.nodes(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX deployment_domain_routes_tenant_idx
  ON public.deployment_domain_routes (tenant_id, updated_at DESC);
CREATE INDEX deployment_domain_routes_deployment_idx
  ON public.deployment_domain_routes (deployment_id, status);

CREATE TRIGGER deployment_domain_routes_set_updated_at
  BEFORE UPDATE ON public.deployment_domain_routes
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();

ALTER TABLE public.deployment_domain_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY deployment_domain_routes_read_member
  ON public.deployment_domain_routes FOR SELECT
  USING (app_private.is_tenant_member(tenant_id));
-- No direct INSERT/UPDATE/DELETE policies. Route intent is created through
-- the narrowly scoped function below and lifecycle changes are trigger-owned.

CREATE OR REPLACE FUNCTION app_private.reconcile_deployment_domain_route(
  p_route_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reconcile_route$
DECLARE
  v_route public.deployment_domain_routes%ROWTYPE;
  v_reason text;
  v_eligible boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_route
    FROM public.deployment_domain_routes
   WHERE id = p_route_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT CASE
    WHEN tenant.status <> 'active' THEN 'tenant_not_active'
    WHEN claim.status <> 'verified' THEN 'domain_not_verified'
    WHEN application.desired_state <> 'running' THEN 'application_not_running'
    WHEN deployment.desired_state <> 'running' OR deployment.status <> 'healthy'
      THEN 'deployment_not_healthy'
    WHEN deployment.runtime_local_port IS NULL
      OR deployment.runtime_observed_at IS NULL
      OR deployment.runtime_observed_at < v_now - interval '5 minutes'
      THEN 'endpoint_missing_or_stale'
    WHEN node.platform <> 'linux'
      OR node.approved_at IS NULL
      OR node.status <> 'online'
      OR node.last_seen_at IS NULL
      OR node.last_seen_at < v_now - make_interval(secs => node.heartbeat_interval_seconds * 3)
      THEN 'node_not_qualified'
    ELSE NULL
  END
  INTO v_reason
  FROM public.tenants AS tenant
  JOIN public.domain_claims AS claim
    ON claim.id = v_route.domain_claim_id AND claim.tenant_id = v_route.tenant_id
  JOIN public.applications AS application
    ON application.id = v_route.application_id AND application.tenant_id = v_route.tenant_id
  JOIN public.deployments AS deployment
    ON deployment.id = v_route.deployment_id
   AND deployment.tenant_id = v_route.tenant_id
   AND deployment.application_id = v_route.application_id
  JOIN public.nodes AS node
    ON node.id = v_route.node_id
   AND node.tenant_id = v_route.tenant_id
   AND deployment.target_node_id = node.id
  WHERE tenant.id = v_route.tenant_id;

  v_eligible := v_reason IS NULL;

  -- Even an otherwise eligible route stays pending_transport. No migration
  -- or database state can activate customer traffic before mTLS transport and
  -- gateway authorization are implemented.
  IF v_eligible THEN
    v_reason := CASE
      WHEN EXISTS (
        SELECT 1 FROM public.nodes AS node
         WHERE node.id = v_route.node_id
           AND node.capabilities_json->>'ingress_tunnel' = 'true'
           AND node.capabilities_json->>'loopback_forwarder' = 'true'
      ) THEN 'transport_not_qualified'
      ELSE 'transport_not_qualified'
    END;
  END IF;

  UPDATE public.deployment_domain_routes
     SET status = CASE WHEN v_eligible THEN 'pending_transport' ELSE 'suspended' END,
         reason_code = COALESCE(v_reason, 'deployment_not_healthy'),
         last_eligible_at = CASE WHEN v_eligible THEN v_now ELSE last_eligible_at END,
         route_version = route_version + CASE
           WHEN status IS DISTINCT FROM CASE WHEN v_eligible THEN 'pending_transport' ELSE 'suspended' END
             OR reason_code IS DISTINCT FROM COALESCE(v_reason, 'deployment_not_healthy')
           THEN 1 ELSE 0 END
   WHERE id = v_route.id;
END
$reconcile_route$;

CREATE OR REPLACE FUNCTION app_private.reconcile_routes_for_deployment(
  p_deployment_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $routes_for_deployment$
DECLARE v_route_id uuid;
BEGIN
  FOR v_route_id IN
    SELECT id FROM public.deployment_domain_routes
     WHERE deployment_id = p_deployment_id
  LOOP
    PERFORM app_private.reconcile_deployment_domain_route(v_route_id);
  END LOOP;
END
$routes_for_deployment$;

CREATE OR REPLACE FUNCTION app_private.reconcile_routes_for_node(
  p_node_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $routes_for_node$
DECLARE v_route_id uuid;
BEGIN
  FOR v_route_id IN
    SELECT id FROM public.deployment_domain_routes
     WHERE node_id = p_node_id
  LOOP
    PERFORM app_private.reconcile_deployment_domain_route(v_route_id);
  END LOOP;
END
$routes_for_node$;

CREATE OR REPLACE FUNCTION app_private.reconcile_routes_for_domain(
  p_domain_claim_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $routes_for_domain$
DECLARE v_route_id uuid;
BEGIN
  FOR v_route_id IN
    SELECT id FROM public.deployment_domain_routes
     WHERE domain_claim_id = p_domain_claim_id
  LOOP
    PERFORM app_private.reconcile_deployment_domain_route(v_route_id);
  END LOOP;
END
$routes_for_domain$;

CREATE OR REPLACE FUNCTION app_private.register_deployment_domain_route(
  p_domain_claim_id uuid,
  p_deployment_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $register_route$
DECLARE
  v_claim public.domain_claims%ROWTYPE;
  v_deployment public.deployments%ROWTYPE;
  v_route_id uuid;
  v_user_id uuid := app_private.current_user_id();
BEGIN
  IF p_domain_claim_id IS NULL OR p_deployment_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'Domain and deployment are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_claim FROM public.domain_claims
   WHERE id = p_domain_claim_id FOR UPDATE;
  SELECT * INTO v_deployment FROM public.deployments
   WHERE id = p_deployment_id FOR UPDATE;

  IF v_claim.id IS NULL OR v_deployment.id IS NULL
     OR v_claim.tenant_id <> v_deployment.tenant_id
     OR NOT app_private.can_manage_tenant(v_claim.tenant_id) THEN
    RAISE EXCEPTION 'Domain and deployment must belong to the same authorized tenant'
      USING ERRCODE = '42501';
  END IF;

  IF v_claim.status <> 'verified'
     OR v_deployment.desired_state <> 'running'
     OR v_deployment.status <> 'healthy'
     OR v_deployment.runtime_local_port IS NULL
     OR v_deployment.runtime_observed_at IS NULL
     OR v_deployment.runtime_observed_at < clock_timestamp() - interval '5 minutes'
     OR v_deployment.target_node_id IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM public.tenants AS tenant
         JOIN public.applications AS application
           ON application.id = v_deployment.application_id
          AND application.tenant_id = v_deployment.tenant_id
         JOIN public.nodes AS node
           ON node.id = v_deployment.target_node_id
          AND node.tenant_id = v_deployment.tenant_id
        WHERE tenant.id = v_deployment.tenant_id
          AND tenant.status = 'active'
          AND application.desired_state = 'running'
          AND node.platform = 'linux'
          AND node.approved_at IS NOT NULL
          AND node.status = 'online'
          AND node.last_seen_at > clock_timestamp() -
            make_interval(secs => node.heartbeat_interval_seconds * 3)
     ) THEN
    RAISE EXCEPTION 'Route requires a verified domain and healthy, fresh Linux deployment endpoint'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.deployment_domain_routes (
    tenant_id, domain_claim_id, application_id, deployment_id, node_id,
    status, reason_code, last_eligible_at
  ) VALUES (
    v_claim.tenant_id, v_claim.id, v_deployment.application_id,
    v_deployment.id, v_deployment.target_node_id,
    'pending_transport', 'transport_not_qualified', clock_timestamp()
  )
  ON CONFLICT (domain_claim_id) DO UPDATE
    SET application_id = EXCLUDED.application_id,
        deployment_id = EXCLUDED.deployment_id,
        node_id = EXCLUDED.node_id,
        status = 'pending_transport',
        reason_code = 'transport_not_qualified',
        route_version = public.deployment_domain_routes.route_version + 1,
        last_eligible_at = clock_timestamp()
  RETURNING id INTO v_route_id;

  PERFORM app_private.reconcile_deployment_domain_route(v_route_id);

  INSERT INTO public.audit_events (
    tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json
  ) VALUES (
    v_claim.tenant_id, 'user', v_user_id, 'domain.route.registered',
    'deployment_domain_route', v_route_id,
    jsonb_build_object(
      'domain_claim_id', v_claim.id,
      'deployment_id', v_deployment.id,
      'application_id', v_deployment.application_id,
      'node_id', v_deployment.target_node_id,
      'status', 'pending_transport'
    )
  );

  RETURN v_route_id;
END
$register_route$;

CREATE OR REPLACE FUNCTION app_private.deployment_domain_route_lifecycle_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $route_lifecycle$
BEGIN
  IF TG_TABLE_NAME = 'deployments' THEN
    PERFORM app_private.reconcile_routes_for_deployment(NEW.id);
  ELSIF TG_TABLE_NAME = 'nodes' THEN
    PERFORM app_private.reconcile_routes_for_node(NEW.id);
  ELSIF TG_TABLE_NAME = 'domain_claims' THEN
    PERFORM app_private.reconcile_routes_for_domain(NEW.id);
  END IF;
  RETURN NEW;
END
$route_lifecycle$;

CREATE TRIGGER deployments_reconcile_domain_routes
  AFTER UPDATE OF status, desired_state, target_node_id, runtime_local_port, runtime_observed_at
  ON public.deployments FOR EACH ROW
  EXECUTE FUNCTION app_private.deployment_domain_route_lifecycle_trigger();
CREATE TRIGGER nodes_reconcile_domain_routes
  AFTER UPDATE OF status, approved_at, last_seen_at, platform, capabilities_json
  ON public.nodes FOR EACH ROW
  EXECUTE FUNCTION app_private.deployment_domain_route_lifecycle_trigger();
CREATE TRIGGER domain_claims_reconcile_domain_routes
  AFTER UPDATE OF status, tenant_id ON public.domain_claims FOR EACH ROW
  EXECUTE FUNCTION app_private.deployment_domain_route_lifecycle_trigger();

REVOKE ALL ON FUNCTION app_private.reconcile_deployment_domain_route(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reconcile_routes_for_deployment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reconcile_routes_for_node(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.reconcile_routes_for_domain(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.register_deployment_domain_route(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.deployment_domain_route_lifecycle_trigger() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.register_deployment_domain_route(uuid, uuid) TO PUBLIC;

COMMIT;

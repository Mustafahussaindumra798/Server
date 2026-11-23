BEGIN;

-- A route can become active only after the node explicitly reports both
-- authenticated ingress tunnel and signed loopback-forwarder readiness.
DO $constraints$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.deployment_domain_routes'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.deployment_domain_routes DROP CONSTRAINT %I', item.conname);
  END LOOP;
END
$constraints$;

ALTER TABLE public.deployment_domain_routes
  ADD CONSTRAINT deployment_domain_routes_status_check
  CHECK (status IN ('pending_transport', 'suspended', 'active'));

DO $reason_constraint$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.deployment_domain_routes'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%reason_code%'
  LOOP
    EXECUTE format('ALTER TABLE public.deployment_domain_routes DROP CONSTRAINT %I', item.conname);
  END LOOP;
END
$reason_constraint$;

ALTER TABLE public.deployment_domain_routes
  ADD CONSTRAINT deployment_domain_routes_reason_code_check
  CHECK (reason_code IN (
    'transport_not_qualified',
    'transport_ready',
    'domain_not_verified',
    'tenant_not_active',
    'application_not_running',
    'deployment_not_healthy',
    'endpoint_missing_or_stale',
    'node_not_qualified'
  ));

CREATE OR REPLACE FUNCTION app_private.reconcile_deployment_domain_route(p_route_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reconcile_route$
DECLARE
  v_route public.deployment_domain_routes%ROWTYPE;
  v_reason text;
  v_eligible boolean := false;
  v_transport_ready boolean := false;
  v_next_status text;
  v_next_reason text;
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
  END,
  (
    node.capabilities_json->>'ingress_tunnel' = 'true'
    AND node.capabilities_json->>'loopback_forwarder' = 'true'
  )
  INTO v_reason, v_transport_ready
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

  IF NOT FOUND THEN v_reason := 'node_not_qualified'; END IF;
  v_eligible := v_reason IS NULL;

  IF NOT v_eligible THEN
    v_next_status := 'suspended';
    v_next_reason := COALESCE(v_reason, 'node_not_qualified');
  ELSIF v_transport_ready THEN
    v_next_status := 'active';
    v_next_reason := 'transport_ready';
  ELSE
    v_next_status := 'pending_transport';
    v_next_reason := 'transport_not_qualified';
  END IF;

  UPDATE public.deployment_domain_routes
     SET status = v_next_status,
         reason_code = v_next_reason,
         last_eligible_at = CASE WHEN v_eligible THEN v_now ELSE last_eligible_at END,
         route_version = route_version + CASE
           WHEN status IS DISTINCT FROM v_next_status
             OR reason_code IS DISTINCT FROM v_next_reason
           THEN 1 ELSE 0 END
   WHERE id = v_route.id;
END
$reconcile_route$;

REVOKE ALL ON FUNCTION app_private.reconcile_deployment_domain_route(uuid) FROM PUBLIC;

COMMIT;

BEGIN;

DO $route_registry_test$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_other_tenant uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_app uuid;
  v_other_app uuid;
  v_node uuid;
  v_other_node uuid;
  v_domain uuid;
  v_unverified_domain uuid;
  v_deployment uuid;
  v_other_deployment uuid;
  v_route uuid;
  v_status text;
  v_reason text;
BEGIN
  INSERT INTO public.users (id, identity_subject, email)
  VALUES (v_user, 'route-registry:' || gen_random_uuid()::text, 'route-' || gen_random_uuid()::text || '@example.test');
  INSERT INTO public.tenants (id, name, slug)
  VALUES
    (v_tenant, 'Route Registry Tenant', 'route-' || replace(v_tenant::text, '-', '')),
    (v_other_tenant, 'Other Route Tenant', 'other-route-' || replace(v_other_tenant::text, '-', ''));
  INSERT INTO public.tenant_memberships (tenant_id, user_id, role, status)
  VALUES (v_tenant, v_user, 'owner', 'active');

  INSERT INTO public.applications (tenant_id, name, desired_state)
  VALUES (v_tenant, 'route-registry-app', 'running') RETURNING id INTO v_app;

  INSERT INTO public.nodes (
    tenant_id, name, platform, architecture, status, approved_at,
    last_seen_at, heartbeat_interval_seconds, capabilities_json
  ) VALUES (
    v_tenant, 'route-registry-node', 'linux', 'x86_64', 'online',
    clock_timestamp(), clock_timestamp(), 30, '{}'::jsonb
  ) RETURNING id INTO v_node;

  INSERT INTO public.domain_claims (tenant_id, hostname, status, created_by, verified_at)
  VALUES (v_tenant, 'route-registry.example.test', 'verified', v_user, clock_timestamp())
  RETURNING id INTO v_domain;
  INSERT INTO public.domain_claims (tenant_id, hostname, status, created_by)
  VALUES (v_tenant, 'unverified-route.example.test', 'pending_verification', v_user)
  RETURNING id INTO v_unverified_domain;

  INSERT INTO public.deployments (
    tenant_id, application_id, revision, target_node_id, desired_state, status,
    image_digest, container_port, resource_requests_json,
    runtime_local_port, runtime_observed_at, health_checked_at
  ) VALUES (
    v_tenant, v_app, 1, v_node, 'running', 'healthy',
    'registry.example.test/app@sha256:' || repeat('a', 64), 8080,
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}',
    49152, clock_timestamp(), clock_timestamp()
  ) RETURNING id INTO v_deployment;

  INSERT INTO public.applications (tenant_id, name, desired_state)
  VALUES (v_other_tenant, 'other-tenant-app', 'running') RETURNING id INTO v_other_app;
  INSERT INTO public.nodes (
    tenant_id, name, platform, architecture, status, approved_at,
    last_seen_at, heartbeat_interval_seconds
  ) VALUES (
    v_other_tenant, 'other-tenant-node', 'linux', 'x86_64', 'online',
    clock_timestamp(), clock_timestamp(), 30
  ) RETURNING id INTO v_other_node;
  INSERT INTO public.deployments (
    tenant_id, application_id, revision, target_node_id, desired_state, status,
    image_digest, container_port, resource_requests_json,
    runtime_local_port, runtime_observed_at, health_checked_at
  ) VALUES (
    v_other_tenant, v_other_app, 1, v_other_node, 'running', 'healthy',
    'registry.example.test/other@sha256:' || repeat('b', 64), 8080,
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}',
    49153, clock_timestamp(), clock_timestamp()
  ) RETURNING id INTO v_other_deployment;

  PERFORM set_config('app.user_id', v_user::text, true);

  v_route := app_private.register_deployment_domain_route(v_domain, v_deployment);
  SELECT status, reason_code INTO v_status, v_reason
    FROM public.deployment_domain_routes WHERE id = v_route;
  IF v_status <> 'pending_transport' OR v_reason <> 'transport_not_qualified' THEN
    RAISE EXCEPTION 'Eligible route intent was not safely held pending transport';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'public'
      AND constraint_name = 'deployment_domain_routes_status_check'
      AND check_clause ILIKE '%active%'
  ) THEN
    RAISE EXCEPTION 'Ingress activation migration did not add the guarded active route state';
  END IF;

  -- A route remains pending until the node explicitly advertises the complete
  -- signed tunnel + loopback-forwarder capability pair.
  UPDATE public.nodes
     SET capabilities_json = '{"ingress_tunnel":true,"loopback_forwarder":true}'::jsonb
   WHERE id = v_node;
  SELECT status, reason_code INTO v_status, v_reason
    FROM public.deployment_domain_routes WHERE id = v_route;
  IF v_status <> 'active' OR v_reason <> 'transport_ready' THEN
    RAISE EXCEPTION 'Qualified ingress transport did not activate the route';
  END IF;


  -- Runtime endpoint port changes invalidate the route version even when
  -- the route remains otherwise eligible and active.
  DECLARE
    v_version_before bigint;
    v_version_after bigint;
  BEGIN
    SELECT route_version INTO v_version_before
      FROM public.deployment_domain_routes WHERE id = v_route;
    UPDATE public.deployments
       SET runtime_local_port = 49154
     WHERE id = v_deployment;
    SELECT route_version, status INTO v_version_after, v_status
      FROM public.deployment_domain_routes WHERE id = v_route;
    IF v_status <> 'active' OR v_version_after <> v_version_before + 1 THEN
      RAISE EXCEPTION 'Loopback port change did not advance active route version exactly once';
    END IF;
    UPDATE public.deployments
       SET runtime_local_port = 49152
     WHERE id = v_deployment;
    SELECT route_version INTO v_version_after
      FROM public.deployment_domain_routes WHERE id = v_route;
    IF v_version_after <> v_version_before + 2 THEN
      RAISE EXCEPTION 'Restored loopback port did not advance route version';
    END IF;
  END;


  -- The route is pinned to its registered node. Moving the deployment to a
  -- different node suspends the old route and advances its version; moving it
  -- back reactivates it with another version increment.
  DECLARE
    v_replacement_node uuid;
    v_route_version_before bigint;
    v_route_version_after bigint;
  BEGIN
    INSERT INTO public.nodes (
      tenant_id, name, platform, architecture, status, approved_at,
      last_seen_at, heartbeat_interval_seconds, capabilities_json
    ) VALUES (
      v_tenant, 'route-replacement-node', 'linux', 'x86_64', 'online',
      clock_timestamp(), clock_timestamp(), 30,
      '{"ingress_tunnel":true,"loopback_forwarder":true}'::jsonb
    ) RETURNING id INTO v_replacement_node;

    SELECT route_version INTO v_route_version_before
      FROM public.deployment_domain_routes WHERE id = v_route;
    UPDATE public.deployments
       SET target_node_id = v_replacement_node
     WHERE id = v_deployment;
    SELECT route_version, status, reason_code
      INTO v_route_version_after, v_status, v_reason
      FROM public.deployment_domain_routes WHERE id = v_route;
    IF v_status <> 'suspended' OR v_reason <> 'node_not_qualified'
       OR v_route_version_after <> v_route_version_before + 1 THEN
      RAISE EXCEPTION 'Deployment target-node change did not suspend and version the pinned route';
    END IF;

    UPDATE public.deployments
       SET target_node_id = v_node
     WHERE id = v_deployment;
    SELECT route_version, status
      INTO v_route_version_after, v_status
      FROM public.deployment_domain_routes WHERE id = v_route;
    IF v_status <> 'active' OR v_route_version_after <> v_route_version_before + 2 THEN
      RAISE EXCEPTION 'Restoring the original target node did not reactivate and version the route';
    END IF;
  END;

  BEGIN
    PERFORM app_private.register_deployment_domain_route(v_unverified_domain, v_deployment);
    RAISE EXCEPTION 'Unverified domain was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    PERFORM app_private.register_deployment_domain_route(v_domain, v_other_deployment);
    RAISE EXCEPTION 'Cross-tenant deployment was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM app_private.register_deployment_domain_route(v_domain, gen_random_uuid());
    RAISE EXCEPTION 'Unknown deployment was accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- Missing or stale runtime endpoint metadata must not be registered.
  INSERT INTO public.deployments (
    tenant_id, application_id, revision, target_node_id, desired_state, status,
    image_digest, container_port, resource_requests_json
  ) VALUES (
    v_tenant, v_app, 2, v_node, 'running', 'healthy',
    'registry.example.test/missing@sha256:' || repeat('c', 64), 8080,
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'
  );
  BEGIN
    PERFORM app_private.register_deployment_domain_route(
      v_domain,
      (SELECT id FROM public.deployments WHERE tenant_id=v_tenant AND application_id=v_app AND revision=2)
    );
    RAISE EXCEPTION 'Deployment without a runtime endpoint was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  UPDATE public.deployments
     SET runtime_observed_at = clock_timestamp() - interval '6 minutes'
   WHERE id = v_deployment;
  SELECT status, reason_code INTO v_status, v_reason
    FROM public.deployment_domain_routes WHERE id = v_route;
  IF v_status <> 'suspended' OR v_reason <> 'endpoint_missing_or_stale' THEN
    RAISE EXCEPTION 'Stale runtime endpoint did not suspend its route';
  END IF;
  UPDATE public.deployments
     SET runtime_observed_at = clock_timestamp()
   WHERE id = v_deployment;
  SELECT status INTO v_status FROM public.deployment_domain_routes WHERE id = v_route;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'Fresh runtime endpoint did not restore the active route';
  END IF;

  -- A deployment that becomes unhealthy immediately withdraws its route intent.
  UPDATE public.deployments SET status = 'failed' WHERE id = v_deployment;
  SELECT status, reason_code INTO v_status, v_reason
    FROM public.deployment_domain_routes WHERE id = v_route;
  IF v_status <> 'suspended' OR v_reason <> 'deployment_not_healthy' THEN
    RAISE EXCEPTION 'Unhealthy deployment did not suspend its route';
  END IF;

  -- A healthy deployment may return to pending transport after health is restored.
  UPDATE public.deployments
     SET status = 'healthy', desired_state = 'running',
         runtime_local_port = 49152, runtime_observed_at = clock_timestamp()
   WHERE id = v_deployment;
  SELECT status INTO v_status FROM public.deployment_domain_routes WHERE id = v_route;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'Recovered deployment route did not return to active';
  END IF;

  -- Node revocation/offline state withdraws the route.
  UPDATE public.nodes SET status = 'offline' WHERE id = v_node;
  SELECT status, reason_code INTO v_status, v_reason
    FROM public.deployment_domain_routes WHERE id = v_route;
  IF v_status <> 'suspended' OR v_reason <> 'node_not_qualified' THEN
    RAISE EXCEPTION 'Offline node did not suspend its route';
  END IF;

  UPDATE public.nodes
     SET status = 'online', last_seen_at = clock_timestamp(), approved_at = clock_timestamp()
   WHERE id = v_node;
  SELECT status INTO v_status FROM public.deployment_domain_routes WHERE id = v_route;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'Recovered node did not restore active route';
  END IF;

  UPDATE public.domain_claims SET status = 'suspended', verified_at = NULL WHERE id = v_domain;
  SELECT status, reason_code INTO v_status, v_reason
    FROM public.deployment_domain_routes WHERE id = v_route;
  IF v_status <> 'suspended' OR v_reason <> 'domain_not_verified' THEN
    RAISE EXCEPTION 'Domain suspension did not withdraw its route';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.audit_events
     WHERE tenant_id = v_tenant
       AND action = 'domain.route.registered'
       AND resource_id = v_route
  ) THEN
    RAISE EXCEPTION 'Route registration audit event missing';
  END IF;
END
$route_registry_test$;

ROLLBACK;

SELECT 'Deployment domain route registry integration checks passed' AS result;

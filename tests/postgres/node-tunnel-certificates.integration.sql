BEGIN;

DO $node_tunnel_certificate_test$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_node uuid;
  v_other_node uuid;
  v_fingerprint text := repeat('a', 64);
  v_authorized boolean;
  v_certificate_id uuid;
BEGIN
  INSERT INTO public.tenants (id, name, slug, status)
  VALUES (v_tenant, 'Tunnel Certificate Tenant', 'tunnel-' || replace(v_tenant::text, '-', ''), 'active');

  INSERT INTO public.nodes (
    tenant_id, name, platform, architecture, status, approved_at,
    last_seen_at, heartbeat_interval_seconds
  ) VALUES (
    v_tenant, 'tunnel-authorized-node', 'linux', 'x86_64', 'online',
    clock_timestamp(), clock_timestamp(), 30
  ) RETURNING id INTO v_node;

  INSERT INTO public.nodes (
    tenant_id, name, platform, architecture, status, approved_at,
    last_seen_at, heartbeat_interval_seconds
  ) VALUES (
    v_tenant, 'tunnel-other-node', 'linux', 'x86_64', 'online',
    clock_timestamp(), clock_timestamp(), 30
  ) RETURNING id INTO v_other_node;

  INSERT INTO public.node_tunnel_certificates (
    tenant_id, node_id, fingerprint_sha256, serial_number, not_before, not_after
  ) VALUES (
    v_tenant, v_node, v_fingerprint, 'test-serial-01',
    clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 day'
  ) RETURNING id INTO v_certificate_id;

  SELECT app_private.authorize_node_tunnel_certificate(v_fingerprint, v_node)
    INTO v_authorized;
  IF v_authorized IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Valid certificate for approved online node was rejected';
  END IF;

  SELECT app_private.authorize_node_tunnel_certificate(v_fingerprint, v_other_node)
    INTO v_authorized;
  IF v_authorized IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Certificate fingerprint was accepted for a different node';
  END IF;

  UPDATE public.node_tunnel_certificates
     SET not_after = clock_timestamp() - interval '1 second'
   WHERE id = v_certificate_id;
  SELECT app_private.authorize_node_tunnel_certificate(v_fingerprint, v_node)
    INTO v_authorized;
  IF v_authorized IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Expired tunnel certificate was accepted';
  END IF;

  UPDATE public.node_tunnel_certificates
     SET not_after = clock_timestamp() + interval '1 day'
   WHERE id = v_certificate_id;
  UPDATE public.nodes SET status = 'offline' WHERE id = v_node;
  SELECT app_private.authorize_node_tunnel_certificate(v_fingerprint, v_node)
    INTO v_authorized;
  IF v_authorized IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Offline node tunnel certificate was accepted';
  END IF;

  UPDATE public.nodes
     SET status = 'online', last_seen_at = clock_timestamp() - interval '2 minutes'
   WHERE id = v_node;
  SELECT app_private.authorize_node_tunnel_certificate(v_fingerprint, v_node)
    INTO v_authorized;
  IF v_authorized IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Stale node heartbeat was accepted for tunnel authorization';
  END IF;

  UPDATE public.nodes SET last_seen_at = clock_timestamp() WHERE id = v_node;
  UPDATE public.tenants SET status = 'suspended' WHERE id = v_tenant;
  SELECT app_private.authorize_node_tunnel_certificate(v_fingerprint, v_node)
    INTO v_authorized;
  IF v_authorized IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Suspended tenant tunnel certificate was accepted';
  END IF;

  UPDATE public.tenants SET status = 'active' WHERE id = v_tenant;
  UPDATE public.node_tunnel_certificates
     SET revoked_at = clock_timestamp()
   WHERE id = v_certificate_id;
  SELECT app_private.authorize_node_tunnel_certificate(v_fingerprint, v_node)
    INTO v_authorized;
  IF v_authorized IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Revoked tunnel certificate was accepted';
  END IF;

  BEGIN
    UPDATE public.node_tunnel_certificates SET revoked_at = NULL WHERE id = v_certificate_id;
    RAISE EXCEPTION 'Revoked certificate was reactivated';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.audit_events
     WHERE tenant_id = v_tenant
       AND resource_type = 'node_tunnel_certificate'
       AND resource_id = v_certificate_id
       AND action = 'node.tunnel_certificate.registered'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.audit_events
     WHERE tenant_id = v_tenant
       AND resource_type = 'node_tunnel_certificate'
       AND resource_id = v_certificate_id
       AND action = 'node.tunnel_certificate.revoked'
  ) THEN
    RAISE EXCEPTION 'Tunnel certificate registration/revocation audit event missing';
  END IF;
END
$node_tunnel_certificate_test$;

ROLLBACK;

SELECT 'Node mTLS certificate authorization checks passed' AS result;

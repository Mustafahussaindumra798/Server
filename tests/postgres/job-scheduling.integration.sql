BEGIN;

-- Exercise the exact least-outstanding-jobs ordering against PostgreSQL.
-- The first queued job must make the second eligible node the next choice.
DO $scheduler_test$
DECLARE
  v_tenant_id uuid := gen_random_uuid();
  v_first_node uuid;
  v_second_node uuid;
  v_first_assignment uuid;
  v_second_assignment uuid;
BEGIN
  INSERT INTO public.tenants (id, name, slug)
  VALUES (v_tenant_id, 'Scheduler Integration', 'scheduler-' || replace(gen_random_uuid()::text, '-', ''));

  INSERT INTO public.nodes (tenant_id, name, platform, architecture, status, approved_at, last_seen_at)
  VALUES
    (v_tenant_id, 'scheduler-node-a', 'linux', 'x86_64', 'online', clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_first_node;

  INSERT INTO public.nodes (tenant_id, name, platform, architecture, status, approved_at, last_seen_at)
  VALUES
    (v_tenant_id, 'scheduler-node-b', 'linux', 'aarch64', 'online', clock_timestamp(), clock_timestamp())
  RETURNING id INTO v_second_node;

  SELECT node.id INTO v_first_assignment
  FROM public.nodes AS node
  WHERE node.tenant_id = v_tenant_id
    AND node.approved_at IS NOT NULL
    AND node.status IN ('online', 'degraded')
    AND node.last_seen_at > clock_timestamp() - make_interval(secs => node.heartbeat_interval_seconds * 3)
  ORDER BY
    (SELECT count(*)::integer FROM public.jobs AS workload
     WHERE workload.node_id = node.id
       AND workload.status IN ('queued', 'leased', 'accepted', 'running')) ASC,
    (SELECT max(previous.created_at) FROM public.jobs AS previous
     WHERE previous.node_id = node.id) ASC NULLS FIRST,
    node.id ASC
  FOR UPDATE OF node SKIP LOCKED
  LIMIT 1;

  INSERT INTO public.jobs (tenant_id, node_id, type, payload_json, idempotency_key)
  VALUES (v_tenant_id, v_first_assignment, 'probe', '{}'::jsonb, 'scheduler-first-job');

  SELECT node.id INTO v_second_assignment
  FROM public.nodes AS node
  WHERE node.tenant_id = v_tenant_id
    AND node.approved_at IS NOT NULL
    AND node.status IN ('online', 'degraded')
    AND node.last_seen_at > clock_timestamp() - make_interval(secs => node.heartbeat_interval_seconds * 3)
  ORDER BY
    (SELECT count(*)::integer FROM public.jobs AS workload
     WHERE workload.node_id = node.id
       AND workload.status IN ('queued', 'leased', 'accepted', 'running')) ASC,
    (SELECT max(previous.created_at) FROM public.jobs AS previous
     WHERE previous.node_id = node.id) ASC NULLS FIRST,
    node.id ASC
  FOR UPDATE OF node SKIP LOCKED
  LIMIT 1;

  IF v_first_assignment IS NULL OR v_second_assignment IS NULL
     OR v_first_assignment = v_second_assignment
     OR NOT (v_first_assignment = v_first_node OR v_first_assignment = v_second_node)
     OR NOT (v_second_assignment = v_first_node OR v_second_assignment = v_second_node) THEN
    RAISE EXCEPTION 'Fair scheduler failed to distribute sequential jobs across the eligible node pool';
  END IF;
END
$scheduler_test$;

ROLLBACK;

\set ON_ERROR_STOP on

-- The RLS integration fixture creates approved node 3000...001 with
-- credential verifier repeat('a', 64). Verify capability refresh is bound
-- to that credential and updates only the authenticated node.
DO $runtime_capabilities$
DECLARE
  v_result record;
  v_count integer;
  v_capabilities jsonb := '{
    "agent_protocol": 1,
    "diagnostics": ["probe", "collect_metrics"],
    "container_runtime": "podman-rootless",
    "runtime_probe": {
      "podman": {
        "available": true,
        "ready": true,
        "version": "5.0.1",
        "rootless": true,
        "cgroup_version": "v2",
        "cgroup_v2_available": true,
        "reason": null
      }
    },
    "workload_execution": false
  }'::jsonb;
BEGIN
  SELECT * INTO v_result
  FROM app_private.accept_node_heartbeat(
    '30000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    'runtime-capability-test',
    'healthy',
    '{}'::jsonb,
    v_capabilities
  );

  IF v_result.node_id <> '30000000-0000-4000-8000-000000000001'
     OR v_result.status <> 'online' THEN
    RAISE EXCEPTION 'Valid node capability heartbeat was not accepted';
  END IF;

  IF (SELECT capabilities_json FROM public.nodes
      WHERE id = '30000000-0000-4000-8000-000000000001') <> v_capabilities THEN
    RAISE EXCEPTION 'Runtime capabilities were not persisted';
  END IF;

  SELECT count(*) INTO v_count
  FROM app_private.accept_node_heartbeat(
    '30000000-0000-4000-8000-000000000001',
    repeat('f', 64),
    'runtime-capability-test',
    'healthy',
    '{}'::jsonb,
    '{"workload_execution":true}'::jsonb
  );

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Invalid node credential was accepted for capability refresh';
  END IF;

  IF (SELECT capabilities_json FROM public.nodes
      WHERE id = '30000000-0000-4000-8000-000000000001') <> v_capabilities THEN
    RAISE EXCEPTION 'Invalid credential changed stored runtime capabilities';
  END IF;
END
$runtime_capabilities$;

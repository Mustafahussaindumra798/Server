BEGIN;

DO $admission_test$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_app uuid;
  v_node_small uuid;
  v_node_large uuid;
  v_first uuid;
  v_second uuid;
  v_request jsonb := '{"cpu_millicores":750,"memory_bytes":268435456,"disk_bytes":1073741824}'::jsonb;
BEGIN
  INSERT INTO public.tenants (id,name,slug)
  VALUES (v_tenant,'Admission Integration','admission-' || replace(gen_random_uuid()::text,'-',''));
  INSERT INTO public.applications (tenant_id,name,resource_requests_json)
  VALUES (v_tenant,'admission-app',v_request) RETURNING id INTO v_app;

  INSERT INTO public.nodes (tenant_id,name,platform,architecture,status,approved_at,last_seen_at,resource_metrics_json)
  VALUES (v_tenant,'admission-small','linux','x86_64','online',clock_timestamp(),clock_timestamp(),
    '{"cpu_cores":1,"cpu_percent":5,"memory_total_bytes":4294967296,"memory_used_bytes":536870912,"disk_available_bytes":10737418240}')
  RETURNING id INTO v_node_small;
  INSERT INTO public.nodes (tenant_id,name,platform,architecture,status,approved_at,last_seen_at,resource_metrics_json)
  VALUES (v_tenant,'admission-large','linux','aarch64','online',clock_timestamp(),clock_timestamp(),
    '{"cpu_cores":2,"cpu_percent":5,"memory_total_bytes":8589934592,"memory_used_bytes":536870912,"disk_available_bytes":21474836480}')
  RETURNING id INTO v_node_large;

  -- First placement chooses the 1-core node (bin-packing), reserving 750m CPU.
  SELECT node.id INTO v_first
  FROM public.nodes AS node
  WHERE node.tenant_id=v_tenant AND node.approved_at IS NOT NULL
    AND node.status IN ('online','degraded')
    AND node.last_seen_at > clock_timestamp()-make_interval(secs => node.heartbeat_interval_seconds*3)
    AND node.resource_metrics_json ?& ARRAY['cpu_cores','cpu_percent','memory_total_bytes','memory_used_bytes','disk_available_bytes']
    AND CASE WHEN (node.resource_metrics_json->>'cpu_cores') ~ '^[1-9][0-9]*$'
      THEN (node.resource_metrics_json->>'cpu_cores')::integer BETWEEN 1 AND 256 ELSE false END
    AND (node.resource_metrics_json->>'cpu_percent')::numeric < 85
    AND ((node.resource_metrics_json->>'cpu_cores')::bigint*1000) >= (v_request->>'cpu_millicores')::bigint
    AND ((node.resource_metrics_json->>'memory_total_bytes')::bigint-(node.resource_metrics_json->>'memory_used_bytes')::bigint) >= (v_request->>'memory_bytes')::bigint
    AND (node.resource_metrics_json->>'disk_available_bytes')::bigint >= (v_request->>'disk_bytes')::bigint
  ORDER BY ((node.resource_metrics_json->>'cpu_cores')::bigint*1000) ASC,node.id
  FOR UPDATE OF node SKIP LOCKED LIMIT 1;
  IF v_first IS NULL THEN RAISE EXCEPTION 'First capacity placement failed'; END IF;
  INSERT INTO public.deployments (tenant_id,application_id,revision,target_node_id,desired_state,status,resource_requests_json)
  VALUES (v_tenant,v_app,1,v_first,'running','scheduled',v_request);

  -- Second placement accounts for the first reservation and cannot overcommit
  -- the 1-core node; the 2-core node must be selected.
  SELECT node.id INTO v_second
  FROM public.nodes AS node
  WHERE node.tenant_id=v_tenant AND node.approved_at IS NOT NULL
    AND node.status IN ('online','degraded')
    AND node.last_seen_at > clock_timestamp()-make_interval(secs => node.heartbeat_interval_seconds*3)
    AND node.resource_metrics_json ?& ARRAY['cpu_cores','cpu_percent','memory_total_bytes','memory_used_bytes','disk_available_bytes']
    AND CASE WHEN (node.resource_metrics_json->>'cpu_cores') ~ '^[1-9][0-9]*$'
      THEN (node.resource_metrics_json->>'cpu_cores')::integer BETWEEN 1 AND 256 ELSE false END
    AND (node.resource_metrics_json->>'cpu_percent')::numeric < 85
    AND ((node.resource_metrics_json->>'cpu_cores')::bigint*1000 -
      COALESCE((SELECT sum((d.resource_requests_json->>'cpu_millicores')::bigint) FROM public.deployments d
        WHERE d.target_node_id=node.id AND d.desired_state='running' AND d.status IN ('queued','scheduled','deploying','healthy')),0)) >= (v_request->>'cpu_millicores')::bigint
    AND ((node.resource_metrics_json->>'memory_total_bytes')::bigint-(node.resource_metrics_json->>'memory_used_bytes')::bigint -
      COALESCE((SELECT sum((d.resource_requests_json->>'memory_bytes')::bigint) FROM public.deployments d
        WHERE d.target_node_id=node.id AND d.desired_state='running' AND d.status IN ('queued','scheduled','deploying','healthy')),0)) >= (v_request->>'memory_bytes')::bigint
    AND ((node.resource_metrics_json->>'disk_available_bytes')::bigint -
      COALESCE((SELECT sum((d.resource_requests_json->>'disk_bytes')::bigint) FROM public.deployments d
        WHERE d.target_node_id=node.id AND d.desired_state='running' AND d.status IN ('queued','scheduled','deploying','healthy')),0)) >= (v_request->>'disk_bytes')::bigint
  ORDER BY (((node.resource_metrics_json->>'cpu_cores')::bigint*1000) -
    COALESCE((SELECT sum((d.resource_requests_json->>'cpu_millicores')::bigint) FROM public.deployments d
      WHERE d.target_node_id=node.id AND d.desired_state='running' AND d.status IN ('queued','scheduled','deploying','healthy')),0)) ASC,node.id
  FOR UPDATE OF node SKIP LOCKED LIMIT 1;
  IF v_first=v_node_small AND v_second<>v_node_large THEN
    RAISE EXCEPTION 'Capacity reservations were not respected; expected large node after small node was reserved';
  END IF;
  IF v_second IS NULL OR v_second=v_first THEN
    RAISE EXCEPTION 'Second capacity placement failed or overcommitted the first node';
  END IF;
END
$admission_test$;

ROLLBACK;

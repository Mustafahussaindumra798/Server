BEGIN;

DO $runtime_reconciliation_test$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_app uuid;
  v_node uuid;
  v_running_deployment uuid;
  v_stopping_deployment uuid;
  v_count integer;
  v_job public.jobs%ROWTYPE;
  v_digest text := 'registry.example.com/cloudexify/recovery@sha256:' || repeat('e',64);
BEGIN
  INSERT INTO public.tenants (id,name,slug)
  VALUES (v_tenant,'Runtime Reconciliation Integration','runtime-reconcile-' || replace(gen_random_uuid()::text,'-',''));
  INSERT INTO public.applications (tenant_id,name)
  VALUES (v_tenant,'runtime-reconcile-app') RETURNING id INTO v_app;
  INSERT INTO public.nodes (tenant_id,name,platform,architecture,status,approved_at,last_seen_at,resource_metrics_json)
  VALUES (v_tenant,'runtime-reconcile-node','linux','x86_64','online',clock_timestamp(),clock_timestamp(),
    '{"cpu_cores":4,"cpu_percent":5,"memory_total_bytes":8589934592,"memory_used_bytes":536870912,"memory_available_bytes":8053063680,"disk_total_bytes":21474836480,"disk_used_bytes":5368709120,"disk_available_bytes":16106127360}')
  RETURNING id INTO v_node;

  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,health_check_path,health_check_timeout_seconds,resource_requests_json
  ) VALUES (
    v_tenant,v_app,1,v_node,'running','healthy',v_digest,8080,'/healthz',30,
    '{"cpu_millicores":500,"memory_bytes":536870912,"disk_bytes":1073741824}'
  ) RETURNING id INTO v_running_deployment;

  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,resource_requests_json
  ) VALUES (
    v_tenant,v_app,2,v_node,'stopped','stopping',v_digest,8080,
    '{"cpu_millicores":500,"memory_bytes":536870912,"disk_bytes":1073741824}'
  ) RETURNING id INTO v_stopping_deployment;

  SELECT app_private.reconcile_node_deployments(v_node) INTO v_count;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Expected two recovery jobs, got %', v_count;
  END IF;
  IF (SELECT status FROM public.deployments WHERE id=v_running_deployment) <> 'deploying' THEN
    RAISE EXCEPTION 'Healthy running revision was not moved to deploying for runtime recovery';
  END IF;

  SELECT * INTO v_job FROM public.jobs
   WHERE deployment_id=v_running_deployment AND type='deploy' AND status='queued';
  IF v_job.id IS NULL
     OR v_job.payload_json->>'image' <> v_digest
     OR v_job.payload_json->>'health_check_path' <> '/healthz'
     OR (v_job.payload_json->'resources'->>'cpu_millicores')::integer <> 500 THEN
    RAISE EXCEPTION 'Recovery deploy job did not preserve the immutable deployment manifest';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.jobs
     WHERE deployment_id=v_stopping_deployment AND type='stop'
       AND status='queued' AND payload_json->>'deployment_id'=v_stopping_deployment::text
  ) THEN
    RAISE EXCEPTION 'Interrupted stop operation was not requeued';
  END IF;

  SELECT app_private.reconcile_node_deployments(v_node) INTO v_count;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'A second reconciliation duplicated active recovery jobs';
  END IF;

  UPDATE public.nodes SET last_seen_at = clock_timestamp() - interval '10 minutes'
   WHERE id=v_node;
  SELECT app_private.reconcile_node_deployments(v_node) INTO v_count;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Stale node was allowed to reconcile workloads';
  END IF;
END
$runtime_reconciliation_test$;

ROLLBACK;

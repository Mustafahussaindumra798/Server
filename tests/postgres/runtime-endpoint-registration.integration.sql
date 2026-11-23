BEGIN;

DO $runtime_endpoint_test$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_app uuid;
  v_node uuid;
  v_deployment uuid;
  v_deploy_job uuid;
  v_stop_job uuid;
  v_attempt uuid;
  v_digest text := 'registry.example.com/cloudexify/endpoint@sha256:' || repeat('c',64);
BEGIN
  INSERT INTO public.tenants (id,name,slug)
  VALUES (v_tenant,'Runtime Endpoint Integration','runtime-endpoint-' || replace(gen_random_uuid()::text,'-',''));
  INSERT INTO public.applications (tenant_id,name)
  VALUES (v_tenant,'runtime-endpoint-app') RETURNING id INTO v_app;
  INSERT INTO public.nodes (tenant_id,name,platform,architecture,status,approved_at,last_seen_at,resource_metrics_json)
  VALUES (v_tenant,'runtime-endpoint-node','linux','x86_64','online',clock_timestamp(),clock_timestamp(),
    '{"cpu_cores":2,"cpu_percent":5,"memory_total_bytes":4294967296,"memory_used_bytes":536870912,"memory_available_bytes":3758096384,"disk_total_bytes":21474836480,"disk_used_bytes":5368709120,"disk_available_bytes":16106127360}')
  RETURNING id INTO v_node;
  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,resource_requests_json
  ) VALUES (
    v_tenant,v_app,1,v_node,'running','deploying',v_digest,8080,
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'
  ) RETURNING id INTO v_deployment;

  INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key)
  VALUES (v_tenant,v_node,v_deployment,'deploy','{}'::jsonb,'runtime-endpoint-deploy:' || v_deployment)
  RETURNING id INTO v_deploy_job;
  INSERT INTO public.job_attempts (job_id,node_id,started_at)
  VALUES (v_deploy_job,v_node,clock_timestamp()) RETURNING id INTO v_attempt;
  UPDATE public.job_attempts
     SET finished_at=clock_timestamp(),
         result_code='workload_healthy',
         result_json=jsonb_build_object(
           'local_port',49152,
           'container_name','cloudexify-' || v_deployment::text
         )
   WHERE id=v_attempt;

  IF (SELECT runtime_local_port FROM public.deployments WHERE id=v_deployment) <> 49152 THEN
    RAISE EXCEPTION 'Verified loopback port was not registered on its deployment';
  END IF;
  IF (SELECT runtime_observed_at FROM public.deployments WHERE id=v_deployment) IS NULL THEN
    RAISE EXCEPTION 'Runtime endpoint observation timestamp was not stored';
  END IF;

  -- A forged container identity must never register an endpoint.
  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,resource_requests_json
  ) VALUES (
    v_tenant,v_app,2,v_node,'running','deploying',v_digest,8080,
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'
  ) RETURNING id INTO v_deployment;
  INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key)
  VALUES (v_tenant,v_node,v_deployment,'deploy','{}'::jsonb,'runtime-endpoint-forged:' || v_deployment)
  RETURNING id INTO v_deploy_job;
  INSERT INTO public.job_attempts (job_id,node_id,started_at)
  VALUES (v_deploy_job,v_node,clock_timestamp()) RETURNING id INTO v_attempt;
  UPDATE public.job_attempts
     SET finished_at=clock_timestamp(),
         result_code='workload_healthy',
         result_json=jsonb_build_object('local_port',49153,'container_name','cloudexify-00000000-0000-4000-8000-000000000000')
   WHERE id=v_attempt;
  IF (SELECT runtime_local_port FROM public.deployments WHERE id=v_deployment) IS NOT NULL THEN
    RAISE EXCEPTION 'Mismatched container identity registered an endpoint';
  END IF;

  -- Stop confirmation removes the registered port.
  SELECT id INTO v_deployment FROM public.deployments
   WHERE tenant_id=v_tenant AND application_id=v_app AND revision=1;
  UPDATE public.deployments SET desired_state='stopped',status='stopping' WHERE id=v_deployment;
  INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key)
  VALUES (v_tenant,v_node,v_deployment,'stop','{}'::jsonb,'runtime-endpoint-stop:' || v_deployment)
  RETURNING id INTO v_stop_job;
  INSERT INTO public.job_attempts (job_id,node_id,started_at)
  VALUES (v_stop_job,v_node,clock_timestamp()) RETURNING id INTO v_attempt;
  UPDATE public.job_attempts
     SET finished_at=clock_timestamp(), result_code='workload_stopped'
   WHERE id=v_attempt;
  IF (SELECT runtime_local_port FROM public.deployments WHERE id=v_deployment) IS NOT NULL THEN
    RAISE EXCEPTION 'Stopped workload retained a stale loopback port';
  END IF;
END
$runtime_endpoint_test$;

ROLLBACK;

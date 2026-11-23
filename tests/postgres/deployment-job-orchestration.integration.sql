BEGIN;

DO $deployment_job_test$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_app uuid;
  v_node uuid;
  v_deployment uuid;
  v_job uuid;
  v_cancel_deployment uuid;
  v_cancel_job uuid;
  v_digest text := 'registry.example.com/cloudexify/demo@sha256:' || repeat('d',64);
BEGIN
  INSERT INTO public.tenants (id,name,slug)
  VALUES (v_tenant,'Deployment Job Integration','deployment-job-' || replace(gen_random_uuid()::text,'-',''));
  INSERT INTO public.applications (tenant_id,name)
  VALUES (v_tenant,'deployment-job-app') RETURNING id INTO v_app;
  INSERT INTO public.nodes (tenant_id,name,platform,architecture,status,approved_at,last_seen_at,resource_metrics_json)
  VALUES (v_tenant,'deployment-job-node','linux','x86_64','online',clock_timestamp(),clock_timestamp(),
    '{"cpu_cores":2,"cpu_percent":5,"memory_total_bytes":4294967296,"memory_used_bytes":536870912,"memory_available_bytes":3758096384,"disk_total_bytes":21474836480,"disk_used_bytes":5368709120,"disk_available_bytes":16106127360}')
  RETURNING id INTO v_node;

  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,resource_requests_json
  ) VALUES (
    v_tenant,v_app,1,v_node,'running','scheduled',v_digest,8080,
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'
  ) RETURNING id INTO v_deployment;

  INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key)
  VALUES (v_tenant,v_node,v_deployment,'deploy',
    jsonb_build_object('deployment_id',v_deployment,'image',v_digest,'container_port',8080,
      'resources',jsonb_build_object('cpu_millicores',250,'memory_bytes',268435456)),
    'deployment:' || v_deployment::text || ':deploy')
  RETURNING id INTO v_job;

  UPDATE public.jobs SET status='running' WHERE id=v_job;
  IF (SELECT status FROM public.deployments WHERE id=v_deployment) <> 'deploying' THEN
    RAISE EXCEPTION 'Deployment did not transition to deploying when node acknowledged running';
  END IF;

  UPDATE public.jobs SET status='failed' WHERE id=v_job;
  IF (SELECT status FROM public.deployments WHERE id=v_deployment) <> 'failed' THEN
    RAISE EXCEPTION 'Deployment did not transition to failed when node reported failure';
  END IF;

  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,resource_requests_json
  ) VALUES (
    v_tenant,v_app,2,v_node,'running','scheduled',v_digest,8080,
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'
  ) RETURNING id INTO v_cancel_deployment;
  INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key)
  VALUES (v_tenant,v_node,v_cancel_deployment,'deploy','{}'::jsonb,
    'deployment:' || v_cancel_deployment::text || ':deploy')
  RETURNING id INTO v_cancel_job;
  UPDATE public.deployments SET status='cancelled',desired_state='stopped' WHERE id=v_cancel_deployment;
  IF (SELECT status FROM public.jobs WHERE id=v_cancel_job) <> 'cancelled' THEN
    RAISE EXCEPTION 'Cancelling a deployment did not cancel its queued node job';
  END IF;
END
$deployment_job_test$;

ROLLBACK;

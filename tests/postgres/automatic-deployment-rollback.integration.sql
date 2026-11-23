BEGIN;

DO $automatic_rollback_test$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_app uuid;
  v_node uuid;
  v_previous uuid;
  v_failed uuid;
  v_failed_job uuid;
  v_rollback uuid;
  v_rollback_job uuid;
  v_no_previous_app uuid;
  v_no_previous_deployment uuid;
  v_no_previous_job uuid;
  v_success_app uuid;
  v_success_previous uuid;
  v_success_failed uuid;
  v_success_failed_job uuid;
  v_success_rollback uuid;
  v_success_rollback_job uuid;
  v_digest text := 'registry.example.com/cloudexify/rollback@sha256:' || repeat('a',64);
  v_new_digest text := 'registry.example.com/cloudexify/broken@sha256:' || repeat('b',64);
BEGIN
  INSERT INTO public.tenants (id,name,slug)
  VALUES (v_tenant,'Automatic Rollback Integration','automatic-rollback-' || replace(gen_random_uuid()::text,'-',''));

  INSERT INTO public.nodes (tenant_id,name,platform,architecture,status,approved_at,last_seen_at,heartbeat_interval_seconds)
  VALUES (v_tenant,'rollback-node','linux','x86_64','online',clock_timestamp(),clock_timestamp(),30)
  RETURNING id INTO v_node;

  INSERT INTO public.applications (tenant_id,name,desired_state)
  VALUES (v_tenant,'rollback-app','running') RETURNING id INTO v_app;

  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,health_check_path,health_check_timeout_seconds,
    health_checked_at,resource_requests_json
  ) VALUES (
    v_tenant,v_app,1,v_node,'running','healthy',v_digest,8080,'/ready',45,
    clock_timestamp(),
    '{"cpu_millicores":500,"memory_bytes":536870912,"disk_bytes":2147483648}'
  ) RETURNING id INTO v_previous;

  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,health_check_path,health_check_timeout_seconds,
    resource_requests_json
  ) VALUES (
    v_tenant,v_app,2,v_node,'running','deploying',v_new_digest,9090,'/healthz',20,
    '{"cpu_millicores":750,"memory_bytes":805306368,"disk_bytes":3221225472}'
  ) RETURNING id INTO v_failed;

  INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key,attempt_count)
  VALUES (v_tenant,v_node,v_failed,'deploy','{}'::jsonb,'rollback-test-failed:' || v_failed,5)
  RETURNING id INTO v_failed_job;

  UPDATE public.jobs SET status='failed' WHERE id=v_failed_job;

  SELECT id INTO v_rollback FROM public.deployments WHERE rollback_of_deployment_id=v_failed;
  IF v_rollback IS NULL THEN
    RAISE EXCEPTION 'Terminal deployment failure did not create an automatic rollback revision';
  END IF;

  SELECT id INTO v_rollback_job FROM public.jobs
   WHERE deployment_id=v_rollback AND type='deploy' AND status='queued';
  IF v_rollback_job IS NULL THEN
    RAISE EXCEPTION 'Automatic rollback revision did not queue a deploy job';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.deployments
     WHERE id=v_rollback AND image_digest=v_digest AND container_port=8080
       AND health_check_path='/ready' AND health_check_timeout_seconds=45
       AND resource_requests_json->>'cpu_millicores'='500'
       AND resource_requests_json->>'memory_bytes'='536870912'
       AND resource_requests_json->>'disk_bytes'='2147483648'
  ) THEN
    RAISE EXCEPTION 'Rollback revision did not preserve the previous healthy immutable manifest';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.jobs
     WHERE id=v_rollback_job
       AND payload_json->>'image'=v_digest
       AND payload_json->>'health_check_path'='/ready'
       AND payload_json->'resources'->>'disk_bytes'='2147483648'
  ) THEN
    RAISE EXCEPTION 'Rollback job payload did not preserve the previous healthy manifest';
  END IF;

  -- A failed rollback must not recursively enqueue another rollback.
  UPDATE public.jobs SET attempt_count=max_attempts, status='failed' WHERE id=v_rollback_job;
  IF (SELECT count(*) FROM public.deployments WHERE application_id=v_app AND rollback_of_deployment_id IS NOT NULL) <> 1 THEN
    RAISE EXCEPTION 'A failed rollback recursively created another rollback revision';
  END IF;
  IF (SELECT status FROM public.deployments WHERE id=v_failed) <> 'failed' THEN
    RAISE EXCEPTION 'Original revision should remain failed when rollback itself fails';
  END IF;

  -- A deployment with no earlier healthy revision must remain failed without a rollback job.
  INSERT INTO public.applications (tenant_id,name,desired_state)
  VALUES (v_tenant,'no-previous-healthy','running') RETURNING id INTO v_no_previous_app;
  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,resource_requests_json
  ) VALUES (
    v_tenant,v_no_previous_app,1,v_node,'running','deploying',v_new_digest,8080,
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'
  ) RETURNING id INTO v_no_previous_deployment;
  INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key,attempt_count)
  VALUES (v_tenant,v_node,v_no_previous_deployment,'deploy','{}'::jsonb,'no-rollback:' || v_no_previous_deployment,5)
  RETURNING id INTO v_no_previous_job;
  UPDATE public.jobs SET status='failed' WHERE id=v_no_previous_job;
  IF EXISTS (SELECT 1 FROM public.deployments WHERE rollback_of_deployment_id=v_no_previous_deployment) THEN
    RAISE EXCEPTION 'Rollback was created despite there being no earlier healthy revision';
  END IF;

  -- A healthy rollback marks the failed revision as rolled_back only after its
  -- own explicit workload_healthy result.
  INSERT INTO public.applications (tenant_id,name,desired_state)
  VALUES (v_tenant,'successful-rollback','running') RETURNING id INTO v_success_app;
  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,health_check_path,health_check_timeout_seconds,
    health_checked_at,resource_requests_json
  ) VALUES (
    v_tenant,v_success_app,1,v_node,'running','healthy',v_digest,8080,'/healthz',30,
    clock_timestamp(),'{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'
  ) RETURNING id INTO v_success_previous;
  INSERT INTO public.deployments (
    tenant_id,application_id,revision,target_node_id,desired_state,status,
    image_digest,container_port,resource_requests_json
  ) VALUES (
    v_tenant,v_success_app,2,v_node,'running','deploying',v_new_digest,8080,
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'
  ) RETURNING id INTO v_success_failed;
  INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key,attempt_count)
  VALUES (v_tenant,v_node,v_success_failed,'deploy','{}'::jsonb,'successful-rollback:' || v_success_failed,5)
  RETURNING id INTO v_success_failed_job;
  UPDATE public.jobs SET status='failed' WHERE id=v_success_failed_job;

  SELECT id INTO v_success_rollback FROM public.deployments WHERE rollback_of_deployment_id=v_success_failed;
  SELECT id INTO v_success_rollback_job FROM public.jobs WHERE deployment_id=v_success_rollback AND type='deploy';
  INSERT INTO public.job_attempts (job_id,node_id,result_code,result_summary,started_at,finished_at)
  VALUES (v_success_rollback_job,v_node,'workload_healthy','Rollback image passed HTTP health check',clock_timestamp(),clock_timestamp());
  UPDATE public.jobs SET status='succeeded' WHERE id=v_success_rollback_job;

  IF (SELECT status FROM public.deployments WHERE id=v_success_rollback) <> 'healthy' THEN
    RAISE EXCEPTION 'Rollback revision was not marked healthy after verified health';
  END IF;
  IF (SELECT status FROM public.deployments WHERE id=v_success_failed) <> 'rolled_back' THEN
    RAISE EXCEPTION 'Failed revision was not marked rolled_back after recovery succeeded';
  END IF;
END
$automatic_rollback_test$;

ROLLBACK;

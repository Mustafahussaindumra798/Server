BEGIN;

DO $automatic_rollback_test$
DECLARE
  v_tenant uuid := gen_random_uuid();
  v_node uuid;
  v_app uuid;
  v_previous uuid;
  v_failed uuid;
  v_failed_job uuid;
  v_rollback_job uuid;
  v_no_previous_app uuid;
  v_no_previous_deployment uuid;
  v_no_previous_job uuid;
  v_success_app uuid;
  v_success_previous uuid;
  v_success_failed uuid;
  v_success_failed_job uuid;
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
    image_digest,container_port,health_check_path,health_check_timeout_seconds,resource_requests_json
  ) VALUES (
    v_tenant,v_app,2,v_node,'running','deploying',v_new_digest,9090,'/healthz',20,
    '{"cpu_millicores":750,"memory_bytes":805306368,"disk_bytes":3221225472}'
  ) RETURNING id INTO v_failed;

  INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key,attempt_count)
  VALUES (v_tenant,v_node,v_failed,'deploy','{}'::jsonb,'rollback-test-failed:' || v_failed,5)
  RETURNING id INTO v_failed_job;
  UPDATE public.jobs SET status='failed' WHERE id=v_failed_job;

  IF (SELECT status FROM public.deployments WHERE id=v_previous) <> 'restarting'
     OR (SELECT rollback_attempt_for_deployment_id FROM public.deployments WHERE id=v_previous) <> v_failed THEN
    RAISE EXCEPTION 'Previous healthy revision was not reserved for an automatic rollback attempt';
  END IF;

  SELECT id INTO v_rollback_job FROM public.jobs
   WHERE deployment_id=v_previous AND type='restart' AND status='queued'
     AND idempotency_key='deployment:' || v_previous::text || ':automatic-rollback:' || v_failed::text;
  IF v_rollback_job IS NULL THEN
    RAISE EXCEPTION 'Automatic rollback did not queue a restart of the previous healthy revision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.jobs
     WHERE id=v_rollback_job AND payload_json->>'deployment_id'=v_previous::text
       AND payload_json->>'container_port'='8080'
       AND payload_json->>'health_check_path'='/ready'
       AND payload_json->>'health_check_timeout_seconds'='45'
  ) THEN
    RAISE EXCEPTION 'Rollback job did not preserve the previous revision health policy';
  END IF;
  IF (SELECT count(*) FROM public.deployments WHERE application_id=v_app) <> 2 THEN
    RAISE EXCEPTION 'Rollback incorrectly created a duplicate deployment revision';
  END IF;

  -- A second deployment failure while the previous revision is already
  -- reserved for rollback must not enqueue a competing recovery job.
  DECLARE
    v_overlapping_deployment uuid;
    v_overlapping_job uuid;
  BEGIN
    INSERT INTO public.deployments (
      tenant_id,application_id,revision,target_node_id,desired_state,status,
      image_digest,container_port,resource_requests_json
    ) VALUES (
      v_tenant,v_app,3,v_node,'running','deploying',v_new_digest,8080,
      '{"cpu_millicores":500,"memory_bytes":536870912,"disk_bytes":2147483648}'
    ) RETURNING id INTO v_overlapping_deployment;
    INSERT INTO public.jobs (tenant_id,node_id,deployment_id,type,payload_json,idempotency_key,attempt_count)
    VALUES (v_tenant,v_node,v_overlapping_deployment,'deploy','{}'::jsonb,
      'overlapping-rollback:' || v_overlapping_deployment,5)
    RETURNING id INTO v_overlapping_job;
    UPDATE public.jobs SET status='failed' WHERE id=v_overlapping_job;
    IF (SELECT count(*) FROM public.jobs WHERE deployment_id=v_previous AND type='restart') <> 1
       OR (SELECT status FROM public.deployments WHERE id=v_previous) <> 'restarting' THEN
      RAISE EXCEPTION 'Overlapping deployment failure created a competing rollback attempt';
    END IF;
  END;

  -- Failed rollback must not recursively trigger another rollback.
  UPDATE public.jobs SET attempt_count=max_attempts, status='failed' WHERE id=v_rollback_job;
  IF (SELECT count(*) FROM public.jobs WHERE deployment_id=v_previous AND type='restart') <> 1 THEN
    RAISE EXCEPTION 'Failed rollback recursively queued another recovery job';
  END IF;
  IF (SELECT status FROM public.deployments WHERE id=v_failed) <> 'failed' THEN
    RAISE EXCEPTION 'Original revision should remain failed when rollback fails';
  END IF;

  -- A deployment with no earlier healthy revision remains failed.
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
  IF EXISTS (SELECT 1 FROM public.deployments WHERE rollback_attempt_for_deployment_id=v_no_previous_deployment) THEN
    RAISE EXCEPTION 'Rollback was attempted despite no earlier healthy revision';
  END IF;

  -- A rollback is successful only after the restored revision passes HTTP health.
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

  SELECT id INTO v_success_rollback_job FROM public.jobs
   WHERE deployment_id=v_success_previous AND type='restart' AND status='queued';
  INSERT INTO public.job_attempts (job_id,node_id,result_code,result_summary,started_at,finished_at)
  VALUES (v_success_rollback_job,v_node,'workload_healthy','Restored revision passed HTTP health check',clock_timestamp(),clock_timestamp());
  UPDATE public.jobs SET status='succeeded' WHERE id=v_success_rollback_job;

  IF (SELECT status FROM public.deployments WHERE id=v_success_previous) <> 'healthy' THEN
    RAISE EXCEPTION 'Restored revision was not healthy after verified restart';
  END IF;
  IF (SELECT status FROM public.deployments WHERE id=v_success_failed) <> 'rolled_back' THEN
    RAISE EXCEPTION 'Failed revision was not marked rolled_back after verified recovery';
  END IF;
  IF (SELECT rollback_attempt_for_deployment_id FROM public.deployments WHERE id=v_success_previous) IS NOT NULL THEN
    RAISE EXCEPTION 'Completed rollback left a stale rollback lock';
  END IF;
END
$automatic_rollback_test$;

ROLLBACK;

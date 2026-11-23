BEGIN;

-- Requeue a small, typed set of desired-state operations when an approved
-- node agent starts after a process/host restart. Row locks make concurrent
-- agent starts safe; active jobs are never duplicated.
CREATE OR REPLACE FUNCTION app_private.reconcile_node_deployments(
  p_node_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $reconcile$
DECLARE
  v_deployment public.deployments%ROWTYPE;
  v_count integer := 0;
BEGIN
  IF p_node_id IS NULL THEN
    RAISE EXCEPTION 'Node ID is required' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.nodes AS node
     WHERE node.id = p_node_id
       AND node.approved_at IS NOT NULL
       AND node.status IN ('online','degraded')
       AND node.last_seen_at > clock_timestamp() - make_interval(secs => node.heartbeat_interval_seconds * 3)
  ) THEN
    RETURN 0;
  END IF;

  FOR v_deployment IN
    SELECT deployment.*
      FROM public.deployments AS deployment
     WHERE deployment.target_node_id = p_node_id
       AND (
         (deployment.desired_state = 'running' AND deployment.status = 'healthy') OR
         (deployment.desired_state = 'stopped' AND deployment.status = 'stopping')
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.jobs AS job
          WHERE job.deployment_id = deployment.id
            AND job.status IN ('queued','leased','accepted','running')
       )
     ORDER BY deployment.updated_at, deployment.id
     FOR UPDATE OF deployment SKIP LOCKED
  LOOP
    IF v_deployment.desired_state = 'running' THEN
      UPDATE public.deployments
         SET status = 'deploying', updated_at = clock_timestamp()
       WHERE id = v_deployment.id;

      INSERT INTO public.jobs (
        tenant_id, node_id, deployment_id, type, payload_json, idempotency_key
      ) VALUES (
        v_deployment.tenant_id,
        p_node_id,
        v_deployment.id,
        'deploy',
        jsonb_build_object(
          'deployment_id', v_deployment.id,
          'image', v_deployment.image_digest,
          'container_port', v_deployment.container_port,
          'health_check_path', v_deployment.health_check_path,
          'health_check_timeout_seconds', v_deployment.health_check_timeout_seconds,
          'resources', jsonb_build_object(
            'cpu_millicores', (v_deployment.resource_requests_json->>'cpu_millicores')::integer,
            'memory_bytes', (v_deployment.resource_requests_json->>'memory_bytes')::bigint
          )
        ),
        'runtime-reconcile:' || v_deployment.id::text || ':' || gen_random_uuid()::text
      );
    ELSE
      INSERT INTO public.jobs (
        tenant_id, node_id, deployment_id, type, payload_json, idempotency_key
      ) VALUES (
        v_deployment.tenant_id,
        p_node_id,
        v_deployment.id,
        'stop',
        jsonb_build_object('deployment_id', v_deployment.id),
        'runtime-reconcile:' || v_deployment.id::text || ':' || gen_random_uuid()::text
      );
    END IF;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$reconcile$;

REVOKE ALL ON FUNCTION app_private.reconcile_node_deployments(uuid) FROM PUBLIC;

COMMIT;

BEGIN;

-- Keep the original five-argument heartbeat function for older agents.
-- New agents use this overload to refresh capability data on every heartbeat.
CREATE OR REPLACE FUNCTION app_private.accept_node_heartbeat(
  p_node_id uuid,
  p_credential_hash text,
  p_agent_version text,
  p_health_status text,
  p_resources jsonb,
  p_capabilities jsonb
)
RETURNS TABLE(node_id uuid,status text,last_seen_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog,public,app_private
AS $heartbeat$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_node_id uuid;
BEGIN
  IF p_node_id IS NULL
     OR p_credential_hash IS NULL
     OR p_credential_hash !~ '^[0-9a-f]{64}$'
     OR (p_agent_version IS NOT NULL AND (length(p_agent_version)=0 OR length(p_agent_version)>40))
     OR p_health_status IS NULL
     OR p_health_status NOT IN ('healthy','degraded')
     OR p_resources IS NULL
     OR jsonb_typeof(p_resources) <> 'object'
     OR octet_length(p_resources::text) > 16384
     OR p_capabilities IS NULL
     OR jsonb_typeof(p_capabilities) <> 'object'
     OR octet_length(p_capabilities::text) > 8192
  THEN
    RAISE EXCEPTION 'Invalid node heartbeat input' USING ERRCODE='22023';
  END IF;

  UPDATE public.node_credentials AS credential
     SET last_used_at = v_now
    FROM public.nodes AS node
   WHERE credential.node_id = p_node_id
     AND node.id = credential.node_id
     AND credential.secret_hash = p_credential_hash
     AND credential.revoked_at IS NULL
     AND (credential.expires_at IS NULL OR credential.expires_at > v_now)
     AND node.status <> 'revoked'
  RETURNING credential.node_id INTO v_node_id;

  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.nodes AS node
     SET last_seen_at = v_now,
         agent_version = COALESCE(p_agent_version,node.agent_version),
         resource_metrics_json = p_resources,
         capabilities_json = p_capabilities,
         status = CASE
           WHEN node.approved_at IS NULL THEN 'pending'
           WHEN p_health_status = 'degraded' THEN 'degraded'
           ELSE 'online'
         END
   WHERE node.id = v_node_id
  RETURNING node.id,node.status,node.last_seen_at;
END
$heartbeat$;

REVOKE ALL ON FUNCTION app_private.accept_node_heartbeat(uuid,text,text,text,jsonb,jsonb) FROM PUBLIC;

DO $grant_runtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudexify_runtime') THEN
    GRANT EXECUTE ON FUNCTION app_private.accept_node_heartbeat(uuid,text,text,text,jsonb,jsonb) TO cloudexify_runtime;
  END IF;
END
$grant_runtime$;

COMMIT;

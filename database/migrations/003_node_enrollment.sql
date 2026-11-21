BEGIN;
CREATE OR REPLACE FUNCTION app_private.enroll_node(
  p_token_hash text, p_name text, p_platform text, p_architecture text,
  p_agent_version text, p_capabilities jsonb, p_credential_hash text
)
RETURNS TABLE(node_id uuid, tenant_id uuid, credential_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $enroll_node$
DECLARE v_tenant_id uuid; v_node_id uuid; v_credential_id uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_credential_hash IS NULL OR p_credential_hash !~ '^[0-9a-f]{64}$'
     OR p_name IS NULL OR length(trim(p_name)) = 0 OR length(p_name) > 100
     OR p_platform IS NULL OR p_platform NOT IN ('linux','android','windows','macos','other')
     OR p_architecture IS NULL OR length(trim(p_architecture)) = 0 OR length(p_architecture) > 40
     OR (p_agent_version IS NOT NULL AND length(p_agent_version) > 40)
     OR p_capabilities IS NULL OR jsonb_typeof(p_capabilities) <> 'object' THEN
    RAISE EXCEPTION 'Invalid node enrollment input' USING ERRCODE = '22023';
  END IF;
  UPDATE public.enrollment_tokens SET used_at = clock_timestamp()
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > clock_timestamp()
   RETURNING public.enrollment_tokens.tenant_id INTO v_tenant_id;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO public.nodes (tenant_id,name,platform,architecture,agent_version,status,capabilities_json)
  VALUES (v_tenant_id,trim(p_name),p_platform,trim(p_architecture),p_agent_version,'pending',p_capabilities)
  RETURNING id INTO v_node_id;
  INSERT INTO public.node_credentials (node_id,secret_hash,expires_at)
  VALUES (v_node_id,p_credential_hash,clock_timestamp()+interval '90 days')
  RETURNING id INTO v_credential_id;
  INSERT INTO public.audit_events (tenant_id,actor_type,actor_id,action,resource_type,resource_id,metadata_json)
  VALUES (v_tenant_id,'system',NULL,'node.enrolled','node',v_node_id,jsonb_build_object('platform',p_platform,'architecture',trim(p_architecture)));
  RETURN QUERY SELECT v_node_id,v_tenant_id,v_credential_id;
END
$enroll_node$;
REVOKE ALL ON FUNCTION app_private.enroll_node(text,text,text,text,text,jsonb,text) FROM PUBLIC;
COMMIT;

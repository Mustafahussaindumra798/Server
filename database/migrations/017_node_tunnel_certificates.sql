BEGIN;

-- The gateway stores only public certificate metadata. Private keys remain
-- on the node and are never uploaded to the control plane.
CREATE TABLE public.node_tunnel_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  node_id uuid NOT NULL,
  fingerprint_sha256 text NOT NULL
    CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  serial_number text NOT NULL
    CHECK (length(serial_number) BETWEEN 1 AND 128),
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (not_after > not_before),
  UNIQUE (fingerprint_sha256),
  FOREIGN KEY (node_id, tenant_id)
    REFERENCES public.nodes(id, tenant_id) ON DELETE RESTRICT,
  UNIQUE (id, node_id)
);
CREATE INDEX node_tunnel_certificates_node_active_idx
  ON public.node_tunnel_certificates (node_id, not_after DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.node_tunnel_certificates ENABLE ROW LEVEL SECURITY;
CREATE POLICY node_tunnel_certificates_read_member
  ON public.node_tunnel_certificates FOR SELECT
  USING (app_private.is_tenant_member(tenant_id));
-- No direct write policy. Provisioning and revocation are operator-controlled.

CREATE OR REPLACE FUNCTION app_private.guard_node_tunnel_certificate_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app_private
AS $guard_tunnel_certificate$
BEGIN
  IF ROW(NEW.tenant_id, NEW.node_id, NEW.fingerprint_sha256, NEW.serial_number,
         NEW.not_before, NEW.not_after)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.node_id, OLD.fingerprint_sha256, OLD.serial_number,
         OLD.not_before, OLD.not_after) THEN
    RAISE EXCEPTION 'Tunnel certificate identity and validity metadata are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'A revoked tunnel certificate cannot be reactivated or rewritten'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard_tunnel_certificate$;

CREATE TRIGGER node_tunnel_certificate_immutable
  BEFORE UPDATE ON public.node_tunnel_certificates
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_node_tunnel_certificate_mutation();

CREATE OR REPLACE FUNCTION app_private.audit_node_tunnel_certificate_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $audit_tunnel_certificate$
DECLARE v_action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'node.tunnel_certificate.registered';
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    v_action := 'node.tunnel_certificate.revoked';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO public.audit_events (
    tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json
  ) VALUES (
    NEW.tenant_id, 'system', NULL, v_action, 'node_tunnel_certificate', NEW.id,
    jsonb_build_object(
      'node_id', NEW.node_id,
      'fingerprint_sha256', NEW.fingerprint_sha256,
      'serial_number', NEW.serial_number,
      'not_after', NEW.not_after
    )
  );
  RETURN NEW;
END
$audit_tunnel_certificate$;

CREATE TRIGGER node_tunnel_certificate_audit_insert
  AFTER INSERT ON public.node_tunnel_certificates
  FOR EACH ROW EXECUTE FUNCTION app_private.audit_node_tunnel_certificate_change();
CREATE TRIGGER node_tunnel_certificate_audit_revoke
  AFTER UPDATE OF revoked_at ON public.node_tunnel_certificates
  FOR EACH ROW EXECUTE FUNCTION app_private.audit_node_tunnel_certificate_change();

CREATE OR REPLACE FUNCTION app_private.authorize_node_tunnel_certificate(
  p_fingerprint_sha256 text,
  p_node_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $authorize_tunnel_certificate$
BEGIN
  IF p_fingerprint_sha256 IS NULL
     OR p_fingerprint_sha256 !~ '^[0-9a-f]{64}$'
     OR p_node_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
      FROM public.node_tunnel_certificates AS certificate
      JOIN public.nodes AS node
        ON node.id = certificate.node_id
       AND node.tenant_id = certificate.tenant_id
      JOIN public.tenants AS tenant
        ON tenant.id = certificate.tenant_id
     WHERE certificate.fingerprint_sha256 = p_fingerprint_sha256
       AND certificate.node_id = p_node_id
       AND certificate.revoked_at IS NULL
       AND certificate.not_before <= clock_timestamp()
       AND certificate.not_after > clock_timestamp()
       AND node.platform = 'linux'
       AND node.approved_at IS NOT NULL
       AND node.status = 'online'
       AND node.last_seen_at IS NOT NULL
       AND node.last_seen_at > clock_timestamp() -
         make_interval(secs => node.heartbeat_interval_seconds * 3)
       AND tenant.status = 'active'
  );
END
$authorize_tunnel_certificate$;

REVOKE ALL ON FUNCTION app_private.authorize_node_tunnel_certificate(text,uuid) FROM PUBLIC;
DO $grant_tunnel_authorizer$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudexify_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app_private.authorize_node_tunnel_certificate(text,uuid) TO cloudexify_runtime';
  END IF;
END
$grant_tunnel_authorizer$;

COMMIT;

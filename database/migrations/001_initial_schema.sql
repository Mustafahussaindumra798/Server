BEGIN;

CREATE SCHEMA IF NOT EXISTS app_private;

CREATE OR REPLACE FUNCTION app_private.current_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_private.current_node_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.node_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_private.is_tenant_member(target_tenant_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.tenant_memberships AS membership
    WHERE membership.tenant_id = target_tenant_id
      AND membership.user_id = app_private.current_user_id()
      AND membership.status = 'active'
  );
END
$;

CREATE OR REPLACE FUNCTION app_private.can_manage_tenant(target_tenant_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $
BEGIN
  RETURN EXISTS (
    SELECT 1
    FROM public.tenant_memberships AS membership
    WHERE membership.tenant_id = target_tenant_id
      AND membership.user_id = app_private.current_user_id()
      AND membership.status = 'active'
      AND membership.role IN ('owner', 'admin')
  );
END
$;

CREATE OR REPLACE FUNCTION app_private.is_current_node(target_node_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT target_node_id = app_private.current_node_id()
$$;

CREATE OR REPLACE FUNCTION app_private.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app_private.reject_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_subject text NOT NULL UNIQUE,
  email text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_identity_subject_nonempty CHECK (length(trim(identity_subject)) > 0)
);

CREATE UNIQUE INDEX users_email_lower_unique
  ON users (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_name_nonempty CHECK (length(trim(name)) > 0),
  CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')
);

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX tenant_memberships_user_idx ON tenant_memberships (user_id, status);

CREATE TABLE nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('linux', 'android', 'windows', 'macos', 'other')),
  architecture text NOT NULL,
  agent_version text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'online', 'degraded', 'offline', 'revoked')),
  approved_at timestamptz,
  last_seen_at timestamptz,
  capabilities_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(capabilities_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nodes_name_nonempty CHECK (length(trim(name)) > 0),
  CONSTRAINT nodes_architecture_nonempty CHECK (length(trim(architecture)) > 0),
  UNIQUE (tenant_id, name),
  UNIQUE (id, tenant_id)
);
CREATE INDEX nodes_tenant_status_idx ON nodes (tenant_id, status);
CREATE INDEX nodes_last_seen_idx ON nodes (last_seen_at);

CREATE TABLE node_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  secret_hash text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CONSTRAINT node_credentials_hash_nonempty CHECK (length(secret_hash) >= 32),
  CONSTRAINT node_credentials_expiry_after_issue CHECK (expires_at IS NULL OR expires_at > issued_at)
);
CREATE INDEX node_credentials_node_idx ON node_credentials (node_id, issued_at DESC);
CREATE INDEX node_credentials_active_idx ON node_credentials (node_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE enrollment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollment_token_hash_nonempty CHECK (length(token_hash) >= 32),
  CONSTRAINT enrollment_token_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX enrollment_tokens_tenant_expiry_idx ON enrollment_tokens (tenant_id, expires_at);

CREATE TABLE applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  desired_state text NOT NULL DEFAULT 'stopped'
    CHECK (desired_state IN ('running', 'stopped', 'suspended')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applications_name_nonempty CHECK (length(trim(name)) > 0),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  application_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  target_node_id uuid,
  desired_state text NOT NULL CHECK (desired_state IN ('running', 'stopped')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'scheduled', 'deploying', 'healthy', 'failed', 'rolled_back', 'cancelled')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, revision),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (application_id, tenant_id)
    REFERENCES applications(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_node_id, tenant_id)
    REFERENCES nodes(id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX deployments_tenant_created_idx ON deployments (tenant_id, created_at DESC);
CREATE INDEX deployments_application_revision_idx ON deployments (application_id, revision DESC);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  node_id uuid NOT NULL,
  deployment_id uuid,
  type text NOT NULL CHECK (type IN ('probe', 'deploy', 'stop', 'restart', 'collect_metrics')),
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload_json) = 'object'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'accepted', 'running', 'succeeded', 'failed', 'cancelled', 'rejected')),
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, node_id, idempotency_key),
  UNIQUE (id, node_id),
  FOREIGN KEY (node_id, tenant_id) REFERENCES nodes(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (deployment_id, tenant_id) REFERENCES deployments(id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT jobs_idempotency_nonempty CHECK (length(trim(idempotency_key)) > 0)
);
CREATE INDEX jobs_lease_queue_idx ON jobs (node_id, status, created_at)
  WHERE status IN ('queued', 'leased');
CREATE INDEX jobs_tenant_created_idx ON jobs (tenant_id, created_at DESC);

CREATE TABLE job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  node_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result_code text,
  result_summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, node_id) REFERENCES jobs(id, node_id) ON DELETE RESTRICT,
  CONSTRAINT job_attempt_finish_after_start CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT job_attempt_summary_size CHECK (result_summary IS NULL OR length(result_summary) <= 4000)
);
CREATE INDEX job_attempts_job_idx ON job_attempts (job_id, started_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'node', 'system')),
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  request_id text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_action_nonempty CHECK (length(trim(action)) > 0),
  CONSTRAINT audit_resource_type_nonempty CHECK (length(trim(resource_type)) > 0)
);
CREATE INDEX audit_events_tenant_created_idx ON audit_events (tenant_id, created_at DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id, created_at DESC);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER tenant_memberships_set_updated_at BEFORE UPDATE ON tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER nodes_set_updated_at BEFORE UPDATE ON nodes
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER applications_set_updated_at BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER deployments_set_updated_at BEFORE UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();
CREATE TRIGGER jobs_set_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();

CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_audit_mutation();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_read_self ON users
  FOR SELECT USING (id = app_private.current_user_id());
CREATE POLICY users_update_self ON users
  FOR UPDATE USING (id = app_private.current_user_id())
  WITH CHECK (id = app_private.current_user_id());

CREATE POLICY tenants_read_member ON tenants
  FOR SELECT USING (app_private.is_tenant_member(id));
CREATE POLICY tenants_update_admin ON tenants
  FOR UPDATE USING (app_private.can_manage_tenant(id))
  WITH CHECK (app_private.can_manage_tenant(id));

CREATE POLICY memberships_read_member ON tenant_memberships
  FOR SELECT USING (app_private.is_tenant_member(tenant_id));
CREATE POLICY memberships_manage_admin ON tenant_memberships
  FOR ALL USING (app_private.can_manage_tenant(tenant_id))
  WITH CHECK (app_private.can_manage_tenant(tenant_id));

CREATE POLICY nodes_read_member ON nodes
  FOR SELECT USING (app_private.is_tenant_member(tenant_id) OR app_private.is_current_node(id));
CREATE POLICY nodes_insert_admin ON nodes
  FOR INSERT WITH CHECK (app_private.can_manage_tenant(tenant_id));
CREATE POLICY nodes_update_admin ON nodes
  FOR UPDATE USING (app_private.can_manage_tenant(tenant_id))
  WITH CHECK (app_private.can_manage_tenant(tenant_id));

CREATE POLICY node_credentials_read_admin ON node_credentials
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM nodes AS node
      WHERE node.id = node_credentials.node_id
        AND app_private.can_manage_tenant(node.tenant_id)
    )
  );
CREATE POLICY node_credentials_manage_admin ON node_credentials
  FOR ALL USING (
    EXISTS (SELECT 1 FROM nodes AS node
      WHERE node.id = node_credentials.node_id
        AND app_private.can_manage_tenant(node.tenant_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM nodes AS node
      WHERE node.id = node_credentials.node_id
        AND app_private.can_manage_tenant(node.tenant_id))
  );

CREATE POLICY enrollment_tokens_manage_admin ON enrollment_tokens
  FOR ALL USING (app_private.can_manage_tenant(tenant_id))
  WITH CHECK (app_private.can_manage_tenant(tenant_id));

CREATE POLICY applications_member_access ON applications
  FOR ALL USING (app_private.is_tenant_member(tenant_id))
  WITH CHECK (app_private.is_tenant_member(tenant_id));
CREATE POLICY deployments_member_access ON deployments
  FOR ALL USING (app_private.is_tenant_member(tenant_id))
  WITH CHECK (app_private.is_tenant_member(tenant_id));

CREATE POLICY jobs_member_or_target_node_access ON jobs
  FOR ALL USING (
    app_private.is_tenant_member(tenant_id) OR app_private.is_current_node(node_id)
  )
  WITH CHECK (
    app_private.is_tenant_member(tenant_id) OR app_private.is_current_node(node_id)
  );
CREATE POLICY job_attempts_member_or_target_node_access ON job_attempts
  FOR ALL USING (
    app_private.is_current_node(node_id)
    OR EXISTS (SELECT 1 FROM jobs AS job
      WHERE job.id = job_attempts.job_id
        AND app_private.is_tenant_member(job.tenant_id))
  )
  WITH CHECK (
    app_private.is_current_node(node_id)
    OR EXISTS (SELECT 1 FROM jobs AS job
      WHERE job.id = job_attempts.job_id
        AND app_private.is_tenant_member(job.tenant_id))
  );

CREATE POLICY audit_events_read_member ON audit_events
  FOR SELECT USING (
    tenant_id IS NOT NULL AND app_private.is_tenant_member(tenant_id)
  );
CREATE POLICY audit_events_insert_member_or_agent ON audit_events
  FOR INSERT WITH CHECK (
    (tenant_id IS NOT NULL AND app_private.is_tenant_member(tenant_id))
    OR (
      actor_type = 'node'
      AND actor_id = app_private.current_node_id()
      AND EXISTS (
        SELECT 1 FROM nodes AS node
        WHERE node.id = app_private.current_node_id()
          AND node.tenant_id = audit_events.tenant_id
      )
    )
  );

GRANT USAGE ON SCHEMA app_private TO PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.current_user_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.current_node_id() TO PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.is_tenant_member(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.can_manage_tenant(uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.is_current_node(uuid) TO PUBLIC;

COMMIT;

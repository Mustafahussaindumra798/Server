-- Run this only AFTER database/migrations/001 through 005 have succeeded.
-- Execute as the Supabase database administrator in SQL Editor.
-- Replace the password placeholder with a unique, high-entropy password first.
-- Keep this password private; it is used only by the Vercel server-side API.

CREATE ROLE cloudexify_runtime
  LOGIN
  PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS;

GRANT CONNECT ON DATABASE postgres TO cloudexify_runtime;
GRANT USAGE ON SCHEMA public, app_private TO cloudexify_runtime;

-- Read paths used by the authenticated control-plane API.
GRANT SELECT ON
  users,
  tenants,
  tenant_memberships,
  nodes,
  node_credentials,
  applications,
  deployments,
  jobs,
  job_attempts
TO cloudexify_runtime;

-- Write paths used by tenant management and audit operations.
GRANT INSERT ON
  tenant_memberships,
  applications,
  deployments,
  enrollment_tokens,
  jobs,
  audit_events
TO cloudexify_runtime;

-- Narrow updates used by node credential revocation and node lifecycle operations.
GRANT UPDATE ON nodes, node_credentials TO cloudexify_runtime;

-- Narrow SECURITY DEFINER entry points for trusted node operations.
GRANT EXECUTE ON FUNCTION app_private.enroll_node(text, text, text, text, text, jsonb, text)
  TO cloudexify_runtime;
GRANT EXECUTE ON FUNCTION app_private.accept_node_heartbeat(uuid, text, text, text, jsonb)
  TO cloudexify_runtime;
GRANT EXECUTE ON FUNCTION app_private.accept_node_heartbeat(uuid, text, text, text, jsonb, jsonb)
  TO cloudexify_runtime;
GRANT EXECUTE ON FUNCTION app_private.node_credential_is_valid(uuid, text)
  TO cloudexify_runtime;
GRANT EXECUTE ON FUNCTION app_private.claim_node_jobs(uuid, text, integer, integer)
  TO cloudexify_runtime;
GRANT EXECUTE ON FUNCTION app_private.acknowledge_node_job(uuid, text, uuid, uuid, uuid, text, text, text)
  TO cloudexify_runtime;

-- Verify the role is not privileged. Expected: both false.
SELECT
  rolname,
  rolsuper,
  rolbypassrls,
  rolcreatedb,
  rolcreaterole
FROM pg_roles
WHERE rolname = 'cloudexify_runtime';

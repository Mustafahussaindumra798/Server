\set ON_ERROR_STOP on

-- This script runs after migrations 001-004 on a disposable PostgreSQL database.
-- Fixtures use fixed UUIDs so the assertions are deterministic.

DO $$
DECLARE
  table_count integer;
  rls_count integer;
BEGIN
  SELECT count(*) INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    AND table_name IN (
      'users','tenants','tenant_memberships','nodes','node_credentials',
      'enrollment_tokens','applications','deployments','jobs','job_attempts','audit_events'
    );
  IF table_count <> 11 THEN
    RAISE EXCEPTION 'Expected 11 application tables, found %', table_count;
  END IF;

  SELECT count(*) INTO rls_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'users','tenants','tenant_memberships','nodes','node_credentials',
      'enrollment_tokens','applications','deployments','jobs','job_attempts','audit_events'
    )
    AND c.relrowsecurity;
  IF rls_count <> 11 THEN
    RAISE EXCEPTION 'Expected RLS on all 11 tables, found %', rls_count;
  END IF;
END $$;

INSERT INTO users (id, identity_subject, email, display_name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'oidc|tenant-a-owner', 'owner-a@example.test', 'Owner A'),
  ('10000000-0000-4000-8000-000000000002', 'oidc|tenant-b-viewer', 'viewer-b@example.test', 'Viewer B');

INSERT INTO tenants (id, name, slug) VALUES
  ('20000000-0000-4000-8000-000000000001', 'Tenant A', 'tenant-a'),
  ('20000000-0000-4000-8000-000000000002', 'Tenant B', 'tenant-b');

INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'viewer');

INSERT INTO nodes (id, tenant_id, name, platform, architecture, status, approved_at) VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'node-a', 'linux', 'x86_64', 'online', now()),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'node-b', 'android', 'aarch64', 'pending');

INSERT INTO node_credentials (node_id, secret_hash) VALUES
  ('30000000-0000-4000-8000-000000000001', repeat('a', 64)),
  ('30000000-0000-4000-8000-000000000002', repeat('b', 64));

INSERT INTO applications (id, tenant_id, name, created_by) VALUES
  ('40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'app-a', '10000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'app-b', '10000000-0000-4000-8000-000000000002');

INSERT INTO deployments (id, tenant_id, application_id, revision, target_node_id, desired_state)
VALUES (
  '50000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  1,
  '30000000-0000-4000-8000-000000000001',
  'running'
);

INSERT INTO jobs (id, tenant_id, node_id, deployment_id, type, idempotency_key)
VALUES
  ('60000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'probe', 'probe-a-1'),
  ('60000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', NULL, 'probe', 'probe-b-1');

INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, resource_type)
VALUES
  ('20000000-0000-4000-8000-000000000001', 'user', '10000000-0000-4000-8000-000000000001', 'fixture.created', 'tenant'),
  ('20000000-0000-4000-8000-000000000002', 'user', '10000000-0000-4000-8000-000000000002', 'fixture.created', 'tenant');

INSERT INTO enrollment_tokens (tenant_id, token_hash, expires_at, created_by)
VALUES ('20000000-0000-4000-8000-000000000001', repeat('c',64), now()+interval '10 minutes', '10000000-0000-4000-8000-000000000001');
DO $enrollment_test$
DECLARE enrolled record; second_attempt integer; stored_hash text;
BEGIN
  SELECT * INTO enrolled FROM app_private.enroll_node(repeat('c',64),'enrolled-node','android','aarch64','test-agent','{"memory_mb":2048}'::jsonb,repeat('d',64));
  IF enrolled.node_id IS NULL OR enrolled.tenant_id <> '20000000-0000-4000-8000-000000000001' THEN RAISE EXCEPTION 'Valid token did not enroll node'; END IF;
  IF (SELECT status FROM nodes WHERE id=enrolled.node_id) <> 'pending' THEN RAISE EXCEPTION 'New node must be pending'; END IF;
  SELECT secret_hash INTO stored_hash FROM node_credentials WHERE id=enrolled.credential_id;
  IF stored_hash <> repeat('d',64) THEN RAISE EXCEPTION 'Credential verifier not stored'; END IF;
  SELECT count(*) INTO second_attempt FROM app_private.enroll_node(repeat('c',64),'duplicate-node','android','aarch64',NULL,'{}'::jsonb,repeat('e',64));
  IF second_attempt <> 0 THEN RAISE EXCEPTION 'Enrollment token accepted more than once'; END IF;
  IF (SELECT count(*) FROM nodes WHERE tenant_id=enrolled.tenant_id AND name IN ('enrolled-node','duplicate-node')) <> 1 THEN RAISE EXCEPTION 'Single-use token created multiple nodes'; END IF;
END
$enrollment_test$;
INSERT INTO enrollment_tokens (tenant_id, token_hash, expires_at, created_by)
VALUES ('20000000-0000-4000-8000-000000000001', repeat('f',64), now()+interval '1 second', '10000000-0000-4000-8000-000000000001');
SELECT pg_sleep(1.1);
DO $expired_enrollment$
DECLARE attempt_count integer;
BEGIN
  SELECT count(*) INTO attempt_count FROM app_private.enroll_node(repeat('f',64),'expired-node','linux','x86_64',NULL,'{}'::jsonb,repeat('1',64));
  IF attempt_count <> 0 THEN RAISE EXCEPTION 'Expired enrollment token accepted'; END IF;
END
$expired_enrollment$;

-- Heartbeat authentication, last-seen persistence and credential rejection.
DO $heartbeat_valid$
DECLARE result record;
BEGIN
 SELECT * INTO result FROM app_private.accept_node_heartbeat('30000000-0000-4000-8000-000000000001',repeat('a',64),'agent-test','healthy','{"cpu_percent":12.5,"memory_total_bytes":4096,"memory_used_bytes":1024}'::jsonb);
 IF result.node_id<>'30000000-0000-4000-8000-000000000001' OR result.status<>'online' OR result.last_seen_at IS NULL THEN RAISE EXCEPTION 'Valid heartbeat was not accepted'; END IF;
 IF (SELECT resource_metrics_json->>'cpu_percent' FROM nodes WHERE id=result.node_id)<>'12.5' THEN RAISE EXCEPTION 'Resource metrics were not persisted'; END IF;
 IF (SELECT last_used_at FROM node_credentials WHERE node_id=result.node_id AND secret_hash=repeat('a',64)) IS NULL THEN RAISE EXCEPTION 'Credential last-use time missing'; END IF;
END $heartbeat_valid$;
INSERT INTO node_credentials(node_id,secret_hash,expires_at) VALUES
 ('30000000-0000-4000-8000-000000000001',repeat('e',64),now()+interval '1 day'),
 ('30000000-0000-4000-8000-000000000001',repeat('9',64),now()-interval '1 second');
UPDATE node_credentials SET revoked_at=now() WHERE secret_hash=repeat('e',64);
DO $heartbeat_rejections$
DECLARE result_count integer;
BEGIN
 SELECT count(*) INTO result_count FROM app_private.accept_node_heartbeat('30000000-0000-4000-8000-000000000001',repeat('e',64),NULL,'healthy','{}'::jsonb);
 IF result_count<>0 THEN RAISE EXCEPTION 'Revoked credential accepted'; END IF;
 SELECT count(*) INTO result_count FROM app_private.accept_node_heartbeat('30000000-0000-4000-8000-000000000001',repeat('9',64),NULL,'healthy','{}'::jsonb);
 IF result_count<>0 THEN RAISE EXCEPTION 'Expired credential accepted'; END IF;
 SELECT count(*) INTO result_count FROM app_private.accept_node_heartbeat('30000000-0000-4000-8000-000000000002',repeat('a',64),NULL,'healthy','{}'::jsonb);
 IF result_count<>0 THEN RAISE EXCEPTION 'Cross-node credential accepted'; END IF;
END $heartbeat_rejections$;

-- Verify tenant-aware composite foreign keys reject a node from another tenant.
DO $$
BEGIN
  BEGIN
    INSERT INTO deployments (tenant_id, application_id, revision, target_node_id, desired_state)
    VALUES (
      '20000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      99,
      '30000000-0000-4000-8000-000000000002',
      'running'
    );
    RAISE EXCEPTION 'Cross-tenant deployment target unexpectedly accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
END $$;

-- Check allowlisted job type and audit immutability at the migration-owner level.
DO $$
BEGIN
  BEGIN
    INSERT INTO jobs (tenant_id, node_id, type, idempotency_key)
    VALUES ('20000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'shell', 'bad-job');
    RAISE EXCEPTION 'Unapproved job type unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE audit_events SET action = 'tampered'
    WHERE tenant_id = '20000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'Audit mutation unexpectedly accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'audit_events is append-only' THEN
      RAISE;
    END IF;
  END;
END $$;

CREATE ROLE cloudexify_test_runtime LOGIN PASSWORD 'test-only-password'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT USAGE ON SCHEMA public, app_private TO cloudexify_test_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cloudexify_test_runtime;
GRANT EXECUTE ON FUNCTION app_private.enroll_node(text,text,text,text,text,jsonb,text) TO cloudexify_test_runtime;
GRANT EXECUTE ON FUNCTION app_private.accept_node_heartbeat(uuid,text,text,text,jsonb) TO cloudexify_test_runtime;

SET ROLE cloudexify_test_runtime;

-- Verified external identity can resolve exactly one pre-provisioned user row.
BEGIN;
SELECT set_config('app.identity_subject', 'oidc|tenant-a-owner', true);
SELECT set_config('app.user_id', '', true);
DO $identity_test$
BEGIN
  IF (SELECT count(*) FROM users) <> 1 THEN
    RAISE EXCEPTION 'Verified identity context did not resolve exactly one user';
  END IF;
  IF (SELECT identity_subject FROM users LIMIT 1) <> 'oidc|tenant-a-owner' THEN
    RAISE EXCEPTION 'Identity context resolved the wrong user';
  END IF;
END $identity_test$;
COMMIT;

DO $identity_test$
BEGIN
  IF COALESCE(current_setting('app.identity_subject', true), '') <> '' THEN
    RAISE EXCEPTION 'Identity context leaked beyond its transaction';
  END IF;
END $identity_test$;

BEGIN;
SELECT set_config('app.user_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.node_id', '', true);

DO $$
DECLARE
  affected integer;
BEGIN
  IF (SELECT count(*) FROM tenants) <> 1 THEN
    RAISE EXCEPTION 'Tenant A user can see rows outside their tenant';
  END IF;
  IF (SELECT count(*) FROM applications) <> 1 THEN
    RAISE EXCEPTION 'Tenant A user can see applications outside their tenant';
  END IF;
  IF (SELECT count(*) FROM users) <> 1 THEN
    RAISE EXCEPTION 'User can see another user profile';
  END IF;

  UPDATE tenant_memberships
  SET role = 'owner'
  WHERE tenant_id = '20000000-0000-4000-8000-000000000002'
    AND user_id = '10000000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'Tenant A user modified Tenant B membership';
  END IF;

  BEGIN
    INSERT INTO applications (tenant_id, name)
    VALUES ('20000000-0000-4000-8000-000000000002', 'cross-tenant-insert');
    RAISE EXCEPTION 'Cross-tenant insert unexpectedly accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $$;
COMMIT;

BEGIN;
SELECT set_config('app.user_id', '', true);
SELECT set_config('app.node_id', '30000000-0000-4000-8000-000000000001', true);

DO $$
BEGIN
  IF (SELECT count(*) FROM nodes) <> 1 THEN
    RAISE EXCEPTION 'Agent can see nodes other than its own';
  END IF;
  IF (SELECT count(*) FROM jobs) <> 1 THEN
    RAISE EXCEPTION 'Agent can see jobs other than its own';
  END IF;
  IF (SELECT count(*) FROM node_credentials) <> 0 THEN
    RAISE EXCEPTION 'Agent can read stored credential verifiers';
  END IF;

  INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, resource_type)
  VALUES (
    '20000000-0000-4000-8000-000000000001',
    'node',
    '30000000-0000-4000-8000-000000000001',
    'agent.test',
    'node'
  );
END $$;
COMMIT;

RESET ROLE;

SELECT 'PostgreSQL integration checks passed' AS result;

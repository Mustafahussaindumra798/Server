\set ON_ERROR_STOP on

-- Migration 015 domain claim and DNS challenge integration tests.
-- The preceding RLS integration test creates cloudexify_test_runtime and fixtures.

INSERT INTO domain_claims (
  id, tenant_id, hostname, created_by
) VALUES (
  '71000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'tenant-b.example.test',
  '10000000-0000-4000-8000-000000000002'
);

INSERT INTO domain_verification_challenges (
  id, domain_claim_id, tenant_id, token_hash, record_name, expires_at
) VALUES (
  '72000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  repeat('b', 64),
  '_cloudexify-verify.tenant-b.example.test',
  now() + interval '5 minutes'
);

SET ROLE cloudexify_test_runtime;

BEGIN;
SELECT set_config('app.user_id', '10000000-0000-4000-8000-000000000001', true);
SELECT set_config('app.node_id', '', true);

DO $domain_rls$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM domain_claims;
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'Tenant A saw another tenant domain claim';
  END IF;

  SELECT count(*) INTO visible_count FROM domain_verification_challenges;
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'Tenant A saw another tenant verification challenge';
  END IF;

  BEGIN
    INSERT INTO domain_claims (tenant_id, hostname, created_by)
    VALUES (
      '20000000-0000-4000-8000-000000000002',
      'forbidden.example.test',
      '10000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Cross-tenant domain claim insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$domain_rls$;

INSERT INTO domain_claims (
  id, tenant_id, hostname, created_by
) VALUES (
  '71000000-0000-4000-8000-000000000011',
  '20000000-0000-4000-8000-000000000001',
  'app.example.test',
  '10000000-0000-4000-8000-000000000001'
);

DO $domain_constraints$
BEGIN
  BEGIN
    INSERT INTO domain_claims (tenant_id, hostname, created_by)
    VALUES (
      '20000000-0000-4000-8000-000000000001',
      'APP.EXAMPLE.TEST',
      '10000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Non-canonical uppercase hostname unexpectedly accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO domain_claims (tenant_id, hostname, created_by)
    VALUES (
      '20000000-0000-4000-8000-000000000001',
      'app.example.test',
      '10000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Duplicate hostname in same tenant unexpectedly accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO domain_verification_challenges (
      domain_claim_id, tenant_id, token_hash, record_name, expires_at
    ) VALUES (
      '71000000-0000-4000-8000-000000000011',
      '20000000-0000-4000-8000-000000000001',
      repeat('c', 64),
      '_cloudexify-verify.wrong.example.test',
      now() + interval '5 minutes'
    );
    RAISE EXCEPTION 'Challenge with mismatched DNS record name unexpectedly accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$domain_constraints$;

INSERT INTO domain_verification_challenges (
  id, domain_claim_id, tenant_id, token_hash, record_name, expires_at
) VALUES (
  '72000000-0000-4000-8000-000000000011',
  '71000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  repeat('a', 64),
  '_cloudexify-verify.app.example.test',
  now() + interval '5 minutes'
);

DO $one_live_challenge$
BEGIN
  BEGIN
    INSERT INTO domain_verification_challenges (
      domain_claim_id, tenant_id, token_hash, record_name, expires_at
    ) VALUES (
      '71000000-0000-4000-8000-000000000011',
      '20000000-0000-4000-8000-000000000001',
      repeat('f', 64),
      '_cloudexify-verify.app.example.test',
      now() + interval '5 minutes'
    );
    RAISE EXCEPTION 'A second live challenge for one claim was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$one_live_challenge$;

DO $domain_challenge_tests$
DECLARE
  verified boolean;
  claim_status text;
  consumed timestamptz;
  audit_count integer;
BEGIN
  SELECT app_private.verify_domain_claim(
    '71000000-0000-4000-8000-000000000011',
    repeat('d', 64)
  ) INTO verified;
  IF verified THEN
    RAISE EXCEPTION 'Incorrect DNS challenge token was accepted';
  END IF;

  SELECT app_private.verify_domain_claim(
    '71000000-0000-4000-8000-000000000001',
    repeat('b', 64)
  ) INTO verified;
  IF verified THEN
    RAISE EXCEPTION 'Cross-tenant domain verification unexpectedly succeeded';
  END IF;

  SELECT app_private.verify_domain_claim(
    '71000000-0000-4000-8000-000000000011',
    repeat('a', 64)
  ) INTO verified;
  IF NOT verified THEN
    RAISE EXCEPTION 'Valid unexpired challenge was not accepted';
  END IF;

  SELECT status INTO claim_status
    FROM domain_claims
   WHERE id = '71000000-0000-4000-8000-000000000011';
  IF claim_status <> 'verified' THEN
    RAISE EXCEPTION 'Domain claim did not transition to verified';
  END IF;

  SELECT consumed_at INTO consumed
    FROM domain_verification_challenges
   WHERE id = '72000000-0000-4000-8000-000000000011';
  IF consumed IS NULL THEN
    RAISE EXCEPTION 'Successful challenge was not consumed';
  END IF;

  SELECT count(*) INTO audit_count
    FROM audit_events
   WHERE tenant_id = '20000000-0000-4000-8000-000000000001'
     AND action = 'domain.verified'
     AND resource_id = '71000000-0000-4000-8000-000000000011';
  IF audit_count <> 1 THEN
    RAISE EXCEPTION 'Domain verification audit event missing';
  END IF;

  SELECT app_private.verify_domain_claim(
    '71000000-0000-4000-8000-000000000011',
    repeat('a', 64)
  ) INTO verified;
  IF verified THEN
    RAISE EXCEPTION 'Consumed challenge was accepted a second time';
  END IF;
END
$domain_challenge_tests$;

COMMIT;

-- The partial unique index is global, not merely tenant-scoped.
RESET ROLE;
DO $global_hostname_uniqueness$
BEGIN
  BEGIN
    INSERT INTO domain_claims (tenant_id, hostname, created_by)
    VALUES (
      '20000000-0000-4000-8000-000000000002',
      'app.example.test',
      '10000000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'A second tenant claimed an active hostname';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$global_hostname_uniqueness$;

-- A challenge past its expiry must not verify, even when the token matches.
INSERT INTO domain_claims (
  id, tenant_id, hostname, created_by
) VALUES (
  '71000000-0000-4000-8000-000000000021',
  '20000000-0000-4000-8000-000000000001',
  'expired.example.test',
  '10000000-0000-4000-8000-000000000001'
);
INSERT INTO domain_verification_challenges (
  id, domain_claim_id, tenant_id, token_hash, record_name, expires_at
) VALUES (
  '72000000-0000-4000-8000-000000000021',
  '71000000-0000-4000-8000-000000000021',
  '20000000-0000-4000-8000-000000000001',
  repeat('e', 64),
  '_cloudexify-verify.expired.example.test',
  now() + interval '1 second'
);
SELECT pg_sleep(1.1);

SET ROLE cloudexify_test_runtime;
BEGIN;
SELECT set_config('app.user_id', '10000000-0000-4000-8000-000000000001', true);
DO $domain_expiry$
DECLARE
  verified boolean;
  claim_status text;
  revoked_count integer;
  active_count integer;
BEGIN
  SELECT app_private.verify_domain_claim(
    '71000000-0000-4000-8000-000000000021',
    repeat('e', 64)
  ) INTO verified;
  IF verified THEN
    RAISE EXCEPTION 'Expired DNS challenge was accepted';
  END IF;

  SELECT status INTO claim_status
    FROM domain_claims
   WHERE id = '71000000-0000-4000-8000-000000000021';
  IF claim_status <> 'pending_verification' THEN
    RAISE EXCEPTION 'Expired challenge changed domain claim state';
  END IF;

  SELECT app_private.revoke_expired_domain_challenges(
    '71000000-0000-4000-8000-000000000021'
  ) INTO revoked_count;
  IF revoked_count <> 1 THEN
    RAISE EXCEPTION 'Expired challenge was not safely revoked';
  END IF;

  INSERT INTO domain_verification_challenges (
    id, domain_claim_id, tenant_id, token_hash, record_name, expires_at
  ) VALUES (
    '72000000-0000-4000-8000-000000000022',
    '71000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000001',
    repeat('f', 64),
    '_cloudexify-verify.expired.example.test',
    now() + interval '5 minutes'
  );

  SELECT count(*) INTO active_count
    FROM domain_verification_challenges
   WHERE domain_claim_id = '71000000-0000-4000-8000-000000000021'
     AND consumed_at IS NULL AND revoked_at IS NULL
     AND expires_at > now();
  IF active_count <> 1 THEN
    RAISE EXCEPTION 'Replacement challenge was not created after expiry revocation';
  END IF;
END
$domain_expiry$;
COMMIT;
RESET ROLE;

SELECT 'Domain claim integration checks passed' AS result;

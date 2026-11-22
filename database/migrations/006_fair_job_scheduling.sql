BEGIN;

-- Tenant-wide idempotency lookup supports auto-placement: a retried request
-- must return the original assignment even when another node is now preferred.
CREATE INDEX jobs_tenant_idempotency_lookup_idx
  ON public.jobs (tenant_id, idempotency_key, created_at);

-- The existing (tenant_id, node_id, idempotency_key) uniqueness constraint is
-- retained for compatibility. API transactions serialize a tenant/key pair
-- with pg_advisory_xact_lock before checking this lookup index and inserting.

COMMIT;

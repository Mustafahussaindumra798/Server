BEGIN;

CREATE TABLE public.domain_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  hostname text NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'verified', 'suspended', 'released')),
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_claims_hostname_canonical CHECK (
    length(hostname) BETWEEN 4 AND 253
    AND hostname = lower(hostname)
    AND hostname !~ '\.$'
    AND hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  CONSTRAINT domain_claims_verified_timestamp CHECK (
    (status = 'verified' AND verified_at IS NOT NULL)
    OR (status <> 'verified' AND verified_at IS NULL)
  ),
  UNIQUE (id, tenant_id)
);

-- A hostname may be claimed by only one tenant at a time. Released claims
-- remain as audit history but no longer reserve the hostname.
CREATE UNIQUE INDEX domain_claims_active_hostname_unique
  ON public.domain_claims (hostname)
  WHERE status <> 'released';
CREATE INDEX domain_claims_tenant_created_idx
  ON public.domain_claims (tenant_id, created_at DESC);

CREATE TABLE public.domain_verification_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_claim_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  token_hash text NOT NULL,
  record_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_challenges_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT domain_challenges_record_name_nonempty CHECK (
    length(record_name) BETWEEN 1 AND 260 AND record_name = lower(record_name)
  ),
  CONSTRAINT domain_challenges_expiry_window CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '1 hour'
  ),
  CONSTRAINT domain_challenges_terminal_exclusive CHECK (
    NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  FOREIGN KEY (domain_claim_id, tenant_id)
    REFERENCES public.domain_claims(id, tenant_id) ON DELETE RESTRICT
);

-- A claim can have one live challenge. Expired challenges must be revoked
-- before a replacement is inserted; the application performs this atomically.
CREATE UNIQUE INDEX domain_challenges_one_live_per_claim
  ON public.domain_verification_challenges (domain_claim_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX domain_challenges_tenant_claim_idx
  ON public.domain_verification_challenges (tenant_id, domain_claim_id, created_at DESC);

CREATE TRIGGER domain_claims_set_updated_at
  BEFORE UPDATE ON public.domain_claims
  FOR EACH ROW EXECUTE FUNCTION app_private.set_updated_at();

ALTER TABLE public.domain_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_verification_challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY domain_claims_read_member ON public.domain_claims
  FOR SELECT USING (app_private.is_tenant_member(tenant_id));
CREATE POLICY domain_claims_insert_admin ON public.domain_claims
  FOR INSERT WITH CHECK (app_private.can_manage_tenant(tenant_id)
    AND created_by = app_private.current_user_id()
    AND status = 'pending_verification'
    AND verified_at IS NULL);
-- No direct UPDATE or DELETE policy: verification and lifecycle transitions
-- must be performed by narrowly scoped SECURITY DEFINER functions.

CREATE POLICY domain_challenges_read_admin ON public.domain_verification_challenges
  FOR SELECT USING (app_private.can_manage_tenant(tenant_id));
CREATE POLICY domain_challenges_insert_admin ON public.domain_verification_challenges
  FOR INSERT WITH CHECK (
    app_private.can_manage_tenant(tenant_id)
    AND consumed_at IS NULL AND revoked_at IS NULL
    AND expires_at > now()
    AND EXISTS (
      SELECT 1 FROM public.domain_claims AS claim
      WHERE claim.id = domain_claim_id
        AND claim.tenant_id = domain_verification_challenges.tenant_id
        AND claim.status = 'pending_verification'
        AND record_name = ('_cloudexify-verify.' || claim.hostname)
    )
  );
-- Challenge mutation is intentionally unavailable to tenant SQL sessions.

CREATE OR REPLACE FUNCTION app_private.verify_domain_claim(
  p_domain_claim_id uuid,
  p_observed_token_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $verify_domain$
DECLARE
  v_claim public.domain_claims%ROWTYPE;
  v_challenge public.domain_verification_challenges%ROWTYPE;
  v_user_id uuid := app_private.current_user_id();
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_domain_claim_id IS NULL
     OR p_observed_token_hash IS NULL
     OR p_observed_token_hash !~ '^[0-9a-f]{64}$'
     OR v_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT claim.* INTO v_claim
    FROM public.domain_claims AS claim
   WHERE claim.id = p_domain_claim_id
   FOR UPDATE;

  IF NOT FOUND
     OR v_claim.status <> 'pending_verification'
     OR NOT app_private.can_manage_tenant(v_claim.tenant_id) THEN
    RETURN false;
  END IF;

  SELECT challenge.* INTO v_challenge
    FROM public.domain_verification_challenges AS challenge
   WHERE challenge.domain_claim_id = v_claim.id
     AND challenge.tenant_id = v_claim.tenant_id
     AND challenge.token_hash = p_observed_token_hash
     AND challenge.consumed_at IS NULL
     AND challenge.revoked_at IS NULL
     AND challenge.expires_at > v_now
   ORDER BY challenge.created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.domain_verification_challenges
     SET consumed_at = v_now
   WHERE id = v_challenge.id
     AND consumed_at IS NULL
     AND revoked_at IS NULL;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.domain_claims
     SET status = 'verified',
         verified_at = v_now
   WHERE id = v_claim.id
     AND tenant_id = v_claim.tenant_id
     AND status = 'pending_verification';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Domain claim changed during verification';
  END IF;

  INSERT INTO public.audit_events (
    tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json
  ) VALUES (
    v_claim.tenant_id, 'user', v_user_id, 'domain.verified',
    'domain_claim', v_claim.id,
    jsonb_build_object('hostname', v_claim.hostname, 'challenge_id', v_challenge.id)
  );

  RETURN true;
END
$verify_domain$;

REVOKE ALL ON FUNCTION app_private.verify_domain_claim(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.verify_domain_claim(uuid, text) TO PUBLIC;

COMMIT;

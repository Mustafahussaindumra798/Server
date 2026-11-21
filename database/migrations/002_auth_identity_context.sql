BEGIN;

-- OIDC identities are resolved by exact issuer|subject after the API has
-- validated the token signature and claims. This policy exposes only the
-- matching user row during the short identity-resolution transaction.
CREATE POLICY users_read_verified_identity ON users
  FOR SELECT
  USING (
    identity_subject = NULLIF(current_setting('app.identity_subject', true), '')
  );

COMMIT;

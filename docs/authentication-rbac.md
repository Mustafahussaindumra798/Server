# Supabase Auth and tenant RBAC

**Status:** Supabase Auth verification is integrated into the API. A user must still be provisioned in the Cloudexify control-plane database and assigned an active tenant membership before the dashboard can display workspace data.

## Supabase Auth configuration

Set these Vercel environment variables for Production and Preview as appropriate:

- `SUPABASE_URL`: the project URL, for example `https://YOUR_PROJECT_REF.supabase.co`.
- `SUPABASE_PUBLISHABLE_KEY`: the project's publishable key. A legacy `SUPABASE_ANON_KEY` is also accepted.
- `DATABASE_URL`: the restricted `cloudexify_runtime` transaction-pooler connection string.

Never put the Supabase secret/service-role key in the browser or Vercel variables used by the dashboard. The browser receives only the publishable/anon key from `GET /api/config`.

The dashboard uses Supabase Auth email/password sign-in. Accounts are provisioned by an administrator; public self-registration is not enabled. Browser sessions are persisted in `localStorage` and refreshed through Supabase Auth before access-token expiry; a stale-token 401 triggers one refresh-and-retry. Transient API/Auth network failures do not erase a valid refresh token. Sign-out clears the browser session and attempts to revoke the Auth session.

Supabase sessions are normally persistent until sign-out or a configured security timeout. The access-token JWT is short-lived (the default is one hour); the rotating refresh token obtains new access tokens without asking the user to log in again. Keep JWT expiry at the recommended one-hour default rather than extending bearer-token validity just to keep the UI signed in. Review **Authentication → Settings → Sessions** if the project has a time-box or inactivity timeout configured; disabling those limits allows sessions to persist until sign-out, subject to Supabase's security rules. Supabase documents session controls and defaults in its [User Sessions guide](https://supabase.com/docs/guides/auth/sessions).

The API validates each access token by calling the configured project's `/auth/v1/user` endpoint with the public API key and bearer token. This delegates signature and expiry verification to Supabase Auth and supports projects using either asymmetric signing keys or the legacy symmetric signing configuration. Successful read-only token verification is cached for at most 10 seconds per warm function instance to reduce polling latency; write requests always verify against Supabase Auth without using that cache. Auth-provider network failures return 503; invalid sessions return 401.

## Provisioning the first Cloudexify user

1. In Supabase Dashboard → Authentication → Users, create or invite the administrator account.
2. Copy the user's Auth UID from that account's details.
3. In SQL Editor, use the following template after replacing the three clearly marked values. Run it only after confirming the user and tenant do not already exist.

```sql
BEGIN;

-- Replace the Auth UID, email, display name, tenant name and slug.
WITH auth_user AS (
  SELECT
    'REPLACE_WITH_AUTH_USER_UUID'::uuid AS auth_uid,
    'admin@example.com'::text AS email,
    'Cloudexify Admin'::text AS display_name,
    'Cloudexify'::text AS tenant_name,
    'cloudexify'::text AS tenant_slug
),
new_user AS (
  INSERT INTO public.users (identity_subject, email, display_name)
  SELECT 'https://YOUR_PROJECT_REF.supabase.co/auth/v1|' || auth_uid::text, email, display_name
  FROM auth_user
  ON CONFLICT (identity_subject) DO UPDATE
    SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
  RETURNING id
),
new_tenant AS (
  INSERT INTO public.tenants (name, slug)
  SELECT tenant_name, tenant_slug FROM auth_user
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
  RETURNING id
)
INSERT INTO public.tenant_memberships (tenant_id, user_id, role, status)
SELECT new_tenant.id, new_user.id, 'owner', 'active'
FROM new_tenant CROSS JOIN new_user
ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner', status = 'active';

COMMIT;
```

Use the exact issuer prefix for your project: `SUPABASE_URL` without a trailing slash, followed by `/auth/v1`. The `identity_subject` must exactly match that issuer, a pipe character, and the Supabase Auth UID. Do not create a second tenant if the intended tenant already exists. Review the values before executing the template.

## Tenant isolation and API authorization

After Supabase validates the bearer token, the API maps `issuer|sub` to the existing `public.users.identity_subject` row. It then sets the transaction-local `app.user_id` context and runs existing tenant membership/RBAC checks. No role is trusted from browser input or editable user metadata.

Existing routes include:
- `GET /api/v1/auth/me`
- `GET /api/v1/tenants`
- `GET /api/v1/tenants/:tenantId/overview` (nodes, applications, deployments, jobs and members in one snapshot)
- `GET /api/v1/tenants/:tenantId/nodes`
- `GET /api/v1/tenants/:tenantId/applications`
- `GET /api/v1/tenants/:tenantId/deployments`
- `GET /api/v1/tenants/:tenantId/jobs`
- `GET /api/v1/tenants/:tenantId/members`
- `POST /api/v1/tenants/:tenantId/applications`
- `POST /api/v1/tenants/:tenantId/deployments` (creates a control-plane revision only; no workload runtime)
- `POST /api/v1/tenants/:tenantId/jobs` (currently targets a selected node; pool scheduling is a later milestone)
- `POST /api/v1/tenants/:tenantId/members`

The dashboard refreshes protected API data every three seconds while active and also offers manual refresh. The startup flow reuses the tenant list returned by `/api/v1/auth/me` to avoid an unnecessary extra API round-trip.

## Edge rate limiting

Vercel Firewall has an active custom rule for the `/api/v1/` path prefix: **600 requests per 60 seconds per source IP**, using a fixed window and deny mitigation after the threshold. This leaves headroom for three-second dashboard refreshes and node heartbeats/job polling. Requests from users/devices behind the same public IP share that IP bucket, so revisit the threshold when the fleet grows. Supabase Auth sign-in remains subject to Supabase's own Auth rate limits; this project rule does not cover the separate Supabase Auth hostname. It does not subscribe directly to private database tables: the current RLS model depends on transaction-local `app.user_id`, not browser `auth.uid()`. Direct Realtime table subscriptions would require a separately designed and reviewed authorization bridge. The browser never receives the database connection string or service-role key.

## Legacy OIDC compatibility

If Supabase Auth variables are absent and all three `OIDC_ISSUER`, `OIDC_AUDIENCE`, and `OIDC_JWKS_URI` values are configured, the API retains the previous RS256 OIDC verifier. When Supabase Auth is configured, it takes precedence.

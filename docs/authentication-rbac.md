# Authentication and tenant RBAC

**Status:** API foundation implemented. Requires an OIDC provider, provisioned users and a PostgreSQL runtime before it can serve authenticated requests.

## Authentication model

The API accepts OIDC access tokens in the HTTP `Authorization: Bearer <token>` header. It verifies the RS256 signature against the configured provider JWKS, then validates issuer, audience, subject, expiry and optional not-before time. Keys are cached for five minutes and unknown key IDs trigger a JWKS refresh.

Required environment:
- `DATABASE_URL`: PostgreSQL connection string.
- `OIDC_ISSUER`: exact issuer URL expected in the token.
- `OIDC_AUDIENCE`: API audience expected in the token.
- `OIDC_JWKS_URI`: trusted HTTPS JWKS endpoint for that issuer.
- `CORS_ORIGINS`: optional comma-separated exact browser origins. No wildcard or credentialed CORS is enabled.

Identity mapping uses the stable composite string `issuer|subject` in `users.identity_subject`. A valid identity that has no pre-provisioned user row is denied; this API does not auto-create accounts, accept client-supplied user IDs, or trust role claims from the token.

Apply migrations in order to a new database:
1. `database/migrations/001_initial_schema.sql`
2. `database/migrations/002_auth_identity_context.sql`

The second migration adds a narrow RLS read policy that permits identity resolution only for the exact `app.identity_subject` set by the API inside a transaction. After lookup, the API sets `app.user_id` and clears the identity-subject context before executing tenant queries. Keep the database credential private and use a non-owner, non-superuser runtime role without `BYPASSRLS`.

## API routes

All routes require a verified OIDC bearer token.

| Method | Route | Permission |
|---|---|---|
| GET | `/api/v1/auth/me` | Authenticated user |
| GET | `/api/v1/tenants` | Active memberships |
| GET | `/api/v1/tenants/:tenantId/applications` | Any active tenant role |
| POST | `/api/v1/tenants/:tenantId/applications` | Owner, Admin |
| POST | `/api/v1/tenants/:tenantId/deployments` | Owner, Admin, Operator |
| GET | `/api/v1/tenants/:tenantId/members` | Any active tenant role |
| POST | `/api/v1/tenants/:tenantId/members` | Owner, Admin |
| GET | `/api/v1/tenants/:tenantId/jobs` | Any active tenant role |
| POST | `/api/v1/tenants/:tenantId/jobs` | Owner, Admin, Operator |

Membership creation accepts an existing `user_id`. Owner may assign Admin, Operator or Viewer. Admin may assign Operator or Viewer. This first version does not implement invitations, ownership transfer, membership removal, password login, browser cookies, or platform-admin access.

## Role matrix

| Capability | Owner | Admin | Operator | Viewer |
|---|---:|---:|---:|---:|
| Read tenant resources | Yes | Yes | Yes | Yes |
| Create applications | Yes | Yes | No | No |
| Request deployments | Yes | Yes | Yes | No |
| Add tenant members | Yes | Yes* | No | No |

* Admin cannot grant Admin or Owner. No tenant role is a platform-wide administrator.

## Security behavior

- Roles come from active PostgreSQL membership rows, never token claims or request bodies.
- Tenant IDs are validated and membership is checked inside the same database transaction as the operation.
- User context uses transaction-local PostgreSQL settings, so pooled connections do not retain the previous request's identity.
- Database queries are parameterized; JSON bodies are limited to 64 KiB.
- Errors do not disclose whether a cross-tenant resource exists.
- API responses use `Cache-Control: no-store`; CORS requires exact configured origins.
- User creation and first-owner bootstrap remain an explicit trusted provisioning operation.
- The OIDC provider must issue access tokens intended for this API. Do not send ID tokens or tokens from unrelated audiences.

## Run

Install dependencies, apply both migrations, provision a user row with `identity_subject = '<issuer>|<subject>'`, configure the environment variables, then run:

    npm install
    npm start

The dashboard remains available without API configuration; authenticated `/api/v1` routes return 503 until database and OIDC settings are present.


## Database runtime grants

Create a dedicated `cloudexify_runtime` role outside the application migration. It must not own the tables, be a superuser, or have `BYPASSRLS`. Grant only the current API's required access:

```sql
GRANT CONNECT ON DATABASE cloudexify TO cloudexify_runtime;
GRANT USAGE ON SCHEMA public, app_private TO cloudexify_runtime;
GRANT SELECT ON users, tenants, tenant_memberships, applications, deployments, nodes, node_credentials, jobs, job_attempts TO cloudexify_runtime;
GRANT INSERT ON tenant_memberships, applications, deployments, audit_events, enrollment_tokens, jobs TO cloudexify_runtime;
GRANT UPDATE ON nodes, node_credentials TO cloudexify_runtime;
GRANT EXECUTE ON FUNCTION app_private.enroll_node(text, text, text, text, text, jsonb, text) TO cloudexify_runtime;
GRANT EXECUTE ON FUNCTION app_private.node_credential_is_valid(uuid, text) TO cloudexify_runtime;
GRANT EXECUTE ON FUNCTION app_private.claim_node_jobs(uuid, text, integer, integer) TO cloudexify_runtime;
GRANT EXECUTE ON FUNCTION app_private.acknowledge_node_job(uuid, text, uuid, uuid, uuid, text, text, text) TO cloudexify_runtime;
```

Replace `cloudexify` with the actual database name. Do not grant broad UPDATE or DELETE access. Extend privileges only alongside a reviewed API feature and its tests.


## Node enrollment and credential lifecycle

Owner/Admin creates a one-time enrollment token:

    POST /api/v1/tenants/:tenantId/enrollment-tokens

Optional body: `{"expires_in_minutes":30}` (5–1440 minutes). The raw token is returned once; only its SHA-256 hash is stored.

The node enrolls using:

    POST /api/v1/nodes/enroll

Body: `{"enrollment_token":"...","name":"edge-01","platform":"android","architecture":"aarch64","agent_version":"0.1.0","capabilities":{}}`

The one-time token is the bootstrap proof. PostgreSQL atomically consumes it, creates a pending node, issues a unique 90-day credential and writes an audit event. The credential secret is returned once; only its SHA-256 hash is stored. Never log or persist the secret in plaintext. Credential-authenticated heartbeat and typed node job polling/acknowledgement are implemented; see [Safe node jobs](node-jobs.md).

Owner/Admin revokes a credential using:

    POST /api/v1/tenants/:tenantId/nodes/:nodeId/credentials/:credentialId/revoke

The operation is tenant-scoped and audited. If no other active, unexpired credential remains, the node status becomes `revoked`.

Apply migration 003 after 001 and 002. Grant the runtime role the narrow permissions it needs, including:

    GRANT EXECUTE ON FUNCTION app_private.enroll_node(text, text, text, text, text, jsonb, text) TO cloudexify_runtime;

The function is SECURITY DEFINER with a fixed search_path and is not executable by PUBLIC. Rate limiting and credential-authenticated node APIs remain future work.

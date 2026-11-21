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
GRANT SELECT ON users, tenants, tenant_memberships, applications, deployments TO cloudexify_runtime;
GRANT INSERT ON tenant_memberships, applications, deployments, audit_events TO cloudexify_runtime;
```

Replace `cloudexify` with the actual database name. Do not grant broad UPDATE or DELETE access. Extend privileges only alongside a reviewed API feature and its tests.

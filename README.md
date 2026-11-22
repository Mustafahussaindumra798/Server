# Cloudexify Server

**Code Your Future** — a multi-device hosting control-plane prototype.

## Current status
This repository contains a dashboard simulation, a Node.js HTTP server, an OIDC-authenticated tenant API foundation, PostgreSQL migrations, and security/integration tests. The dashboard still uses in-memory sample data only. No real device connects and no workload is deployed.

## Run locally
Requires Node.js 20 or newer and PostgreSQL for authenticated API routes.

```bash
npm install
npm start
```

Open http://127.0.0.1:4173. Set `PORT` or `HOST` to override the defaults.

Health check: `GET /api/health`.

## Configure authentication API
Apply migrations in order:
1. `database/migrations/001_initial_schema.sql`
2. `database/migrations/002_auth_identity_context.sql`
3. `database/migrations/003_node_enrollment.sql`
4. `database/migrations/004_node_heartbeat.sql`
4. `database/migrations/004_node_heartbeat.sql`

Configure `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`, and optionally `CORS_ORIGINS`. Provision users by storing `issuer|subject` in `users.identity_subject`. Full setup and role permissions are documented in [Authentication and RBAC](docs/authentication-rbac.md).

The dashboard runs without these settings. Authenticated `/api/v1` routes return 503 until the database and OIDC provider are configured.

## Database and architecture
- Schema: [database/migrations/001_initial_schema.sql](database/migrations/001_initial_schema.sql)
- Authentication identity policy: [database/migrations/002_auth_identity_context.sql](database/migrations/002_auth_identity_context.sql)
- Node enrollment function: [database/migrations/003_node_enrollment.sql](database/migrations/003_node_enrollment.sql)
- Node heartbeat function: [database/migrations/004_node_heartbeat.sql](database/migrations/004_node_heartbeat.sql)
- [Node heartbeat API](docs/node-heartbeat.md)
- Database notes: [docs/database.md](docs/database.md)
- Authentication and RBAC: [docs/authentication-rbac.md](docs/authentication-rbac.md)
- [System architecture](docs/architecture.md)
- [Control-plane backend design](docs/control-plane-design.md)
- [Node OS/runtime support matrix](docs/node-runtime-support.md)
- [Delivery roadmap](docs/roadmap.md)

Node enrollment and the authenticated heartbeat API are implemented. A packaged node agent, scheduling, remote command execution, real workload execution and production hosting are not implemented yet.

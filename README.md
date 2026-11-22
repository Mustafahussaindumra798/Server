# Cloudexify Server

**Code Your Future** — a multi-device hosting control-plane prototype.

## Current status

This repository contains a live dashboard shell, a Node.js HTTP API, a Vercel serverless adapter, Supabase Auth verification, tenant RBAC, PostgreSQL migrations, and node enrollment/heartbeat/job APIs. The dashboard loads real workspace records through a combined protected snapshot and refreshes every 3 seconds while active. It includes application, deployment-request, member, node-enrollment and diagnostic-job management flows. Session refresh is automatic and stale access tokens are retried once. No real workload deployment/runtime is claimed.

## Run locally

Requires Node.js 20 or newer and PostgreSQL for authenticated API routes.

```bash
npm install
npm start
```

Open http://127.0.0.1:4173. Set `PORT` or `HOST` to override the defaults. Health check: `GET /api/health`.

## Deploy dashboard and API to Vercel

The repository root is the Vercel project root. Static dashboard files (`index.html`, `app.js`, `styles.css`) are served from the root, while `api/` contains Vercel Node.js Functions. PostgreSQL remains in Supabase.

Set `DATABASE_URL`, `DB_POOL_MAX=1`, `CORS_ORIGINS`, `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY` in Vercel. A legacy `SUPABASE_ANON_KEY` is also accepted. Never expose the Supabase secret/service-role key or database URL in browser code.

Follow [Vercel + Supabase deployment](docs/deployment/vercel-supabase.md) and [Supabase Auth and tenant RBAC](docs/authentication-rbac.md).

## Database and architecture

- Schema and policies: [database/migrations](database/migrations)
- Runtime role: [supabase/setup/001_runtime_role.sql](supabase/setup/001_runtime_role.sql)
- [Authentication and tenant RBAC](docs/authentication-rbac.md)
- [Safe node job protocol](docs/node-jobs.md)
- [Node heartbeat API](docs/node-heartbeat.md)
- [Android / Termux node agent](docs/termux-agent.md)
- [System architecture](docs/architecture.md)
- [Delivery roadmap](docs/roadmap.md)

Node enrollment, authenticated heartbeat, and the typed diagnostic job queue are implemented. Only non-mutating `probe` and `collect_metrics` jobs are enabled; arbitrary shell execution is not supported. The Linux node agent is implemented for diagnostic operations. General workload execution, scheduling, automatic installation/upgrades and production hosting are not implemented yet.

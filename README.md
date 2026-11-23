# Cloudexify Server

**Code Your Future** — a multi-device hosting control-plane prototype.

## Current status

This repository contains a live dashboard and Node.js control-plane API, Supabase Auth verification, tenant RBAC, PostgreSQL migrations, node enrollment/heartbeat/job APIs, scheduler admission, typed workload orchestration, a rootless Podman runtime adapter, immutable-image signature verification, health-gated deploy/stop/restart lifecycle, automatic rollback orchestration and node-local endpoint registration. Workload execution is gated to qualified Linux nodes. Android/Termux nodes remain diagnostics/scheduler test nodes. Public customer ingress, domain verification, TLS automation, persistent volumes and production Linux qualification are not complete; customer-facing hosting is not yet available.

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
- [Secure multi-node ingress architecture decision](docs/ingress-architecture.md)
- [Delivery roadmap](docs/roadmap.md)

Node enrollment, authenticated heartbeat, diagnostic jobs, workload scheduling and typed lifecycle orchestration are implemented in code and CI. The Linux runtime uses rootless Podman and fail-closed qualification gates. Public ingress is deliberately not enabled: workloads remain loopback-published until domain verification, authenticated node tunnels, gateway routing and TLS lifecycle are implemented and physically qualified.

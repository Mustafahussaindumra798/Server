# Cloudexify Server

**Code Your Future** — a multi-device hosting control-plane prototype.

## Current status
This repository contains a dashboard simulation, a small Node.js development server, a documented control-plane design, and an initial PostgreSQL schema migration. The dashboard still uses in-memory sample data only. No real device connects, no workload is deployed, and no live database is configured.

## Run the dashboard locally
Requires Node.js 20 or newer.

```bash
node server.mjs
```

Open http://127.0.0.1:4173. Set `PORT` or `HOST` to override the defaults.

Health check: `GET /api/health`.

## Database foundation
- Schema migration: [database/migrations/001_initial_schema.sql](database/migrations/001_initial_schema.sql)
- Apply and security notes: [docs/database.md](docs/database.md)

The migration has not been applied to a live database. Review it and test it against a disposable PostgreSQL instance before connecting an API.

## Architecture
- [System architecture](docs/architecture.md)
- [Control-plane backend design](docs/control-plane-design.md)
- [Delivery roadmap](docs/roadmap.md)

Real authentication, node enrollment, heartbeat processing, scheduling, workload execution and production hosting are not implemented yet.

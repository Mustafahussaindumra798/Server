# Database foundation

**Migrations:** database/migrations/001_initial_schema.sql through 005_safe_node_jobs.sql
**Engine:** PostgreSQL 15+ (CI currently runs PostgreSQL 16).
**Status:** Initial schema and RLS policies committed; not applied to a live customer database.

## Reproducible validation

A GitHub Actions workflow at .github/workflows/postgres-integration.yml starts a disposable PostgreSQL 16 service for pushes to main, pull requests, and manual runs. It applies migrations 001–005, runs SQL integration checks, and runs the Node.js test suite.

The integration script verifies:
- all 11 application tables exist and have row-level security enabled;
- cross-tenant composite foreign keys reject a deployment targeting another tenant's node;
- unsupported job types are rejected;
- audit rows cannot be updated or deleted;
- a tenant A user cannot read tenant B records or mutate tenant B membership;
- cross-tenant inserts are rejected by RLS;
- an authenticated node sees only its own node and jobs;
- a node cannot read stored credential verifiers;
- an agent can append an audit event for its own tenant/node identity;\n- approved nodes can claim typed jobs using credential-bound leases;\n- job attempts are isolated, failed jobs retry with bounded backoff, and stale leases cannot acknowledge newer attempts.

The workflow creates a temporary, non-superuser, NOBYPASSRLS database role and fixed test-only fixtures. It does not connect to a production database or use real credentials.

## Apply manually

Back up the target database first. Apply once to an empty disposable database using a dedicated migration owner, not the application runtime account:

    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/001_initial_schema.sql

This is a one-time migration. Do not rerun it on an already migrated database. Add a migration ledger/runner before migration 002.

## RLS transaction context

Policies use transaction-local PostgreSQL settings:
- app.user_id: authenticated Cloudexify user UUID
- app.node_id: authenticated node UUID

The trusted API must set these values inside every transaction, only after validating the user or node credential. Never accept either value directly from an HTTP request or dashboard form.

These settings are defense in depth against accidentally unscoped queries, not an independent security boundary against arbitrary SQL execution as the application database role: that role can set custom PostgreSQL settings. Keep database credentials server-side, use parameterized queries, minimize SQL privileges, and perform authorization in the API. The runtime role must not own the tables and must not have BYPASSRLS or superuser privileges. Keep the migration owner separate.

The migration does not create provider-specific roles or grant broad table privileges. Provision a least-privilege runtime role for the selected environment before connecting an API.

## Security notes

- Node agents cannot read credential verifiers or job tables directly; authenticated job polling and acknowledgement use narrowly scoped SECURITY DEFINER functions. Job payloads are typed diagnostics only, never shell commands.
- Node agents do not directly update the nodes table. Heartbeat updates should be implemented through a narrowly scoped API/database function after authentication; do not grant broad table update access to agents.
- Create the first tenant and owner membership through a controlled bootstrap operation.
- User records map to an external OIDC identity subject; passwords and login are out of scope.
- Enrollment tokens and node credentials are stored as hashes/verifiers only.
- Enforce owner/admin/operator/viewer permissions in the API; RLS does not replace endpoint-level role checks.
- Keep high-volume telemetry out of audit events and define retention before adding metrics.

## Not included

No live database was provisioned or modified. No production credentials, Supabase project, cloud database, authentication provider, API service, or device agent was connected. The PostgreSQL CI job is the runtime validation gate; its actual result must be checked after GitHub Actions executes.

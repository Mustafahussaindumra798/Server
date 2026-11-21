# Database foundation

**Migration:** `database/migrations/001_initial_schema.sql`
**Engine:** PostgreSQL 15+ recommended.
**Status:** Initial schema and RLS policies committed; not applied to a live database.

## Apply

Back up the target database first. Apply once to an empty project database using a dedicated migration owner, not the application runtime account:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/001_initial_schema.sql
```

This is a one-time versioned migration. Do not rerun it on an already migrated database. Add a migration ledger/runner before migration 002.

## Tables

| Area | Tables |
|---|---|
| Identity and tenancy | `users`, `tenants`, `tenant_memberships` |
| Device registry | `nodes`, `node_credentials`, `enrollment_tokens` |
| Workload control | `applications`, `deployments`, `jobs`, `job_attempts` |
| Security history | `audit_events` |

Includes UUID keys, foreign keys, tenant-aware composite foreign keys, constraints, indexes, update timestamps, row-level security and append-only audit rows.

## RLS transaction context

Policies use transaction-local PostgreSQL settings:
- `app.user_id`: authenticated Cloudexify user UUID
- `app.node_id`: authenticated node UUID

The trusted API sets these values inside every transaction, only after validating the user or node credential:

```sql
BEGIN;
SELECT set_config('app.user_id', '<authenticated-user-uuid>', true);
SELECT set_config('app.node_id', '', true);
-- Execute tenant-scoped statements in this transaction.
COMMIT;
```

For an agent transaction, clear `app.user_id` and set `app.node_id` to the authenticated node UUID. Never accept either value directly from an HTTP request or dashboard form.

These settings are defense in depth against accidentally unscoped queries, not an independent security boundary against arbitrary SQL execution as the application database role: that role can set custom PostgreSQL settings. Keep database credentials server-side, use parameterized queries, minimize SQL privileges, and perform authorization in the API. The runtime role must not own the tables and must not have `BYPASSRLS` or superuser privileges. Keep the migration owner separate.

The migration does not create provider-specific roles or grant broad table privileges. Provision a least-privilege runtime role for the selected environment before connecting an API.

## Implementation notes

- Create the first tenant and owner membership through a controlled bootstrap operation/transaction; ordinary tenant policies intentionally do not allow arbitrary tenant creation.
- User records map to an external OIDC identity subject; passwords and login are out of scope.
- Enrollment tokens and node credentials are stored as hashes/verifiers only. Generate high-entropy random secrets in the API and return plaintext once.
- Credential rotation may temporarily retain multiple credentials for one node; revoke the old credential after confirming the replacement.
- Enforce owner/admin/operator/viewer permissions and owner-transfer rules in the API. RLS does not replace endpoint-level role checks.
- Heartbeat updates use server receipt time, not device timestamps.
- Job types are allowlisted. Arbitrary shell execution is not included.
- Keep high-volume telemetry out of audit events and define retention before adding metrics.

## Not included

No live database was provisioned or modified. No credentials, Supabase project, cloud database, authentication provider, API service or device agent was connected. SQL execution against a disposable PostgreSQL instance and integration tests remain the next verification gate.

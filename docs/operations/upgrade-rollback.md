# Cloudexify Server — Upgrade Strategy, Database Migration & Rollback Runbook

This document defines the zero-downtime deployment, database schema migration protocol, and service rollback procedures for Cloudexify Server.

---

## 1. Zero-Downtime Migration Policy (Expand / Contract)

Database schema changes must always be backward-compatible with running application versions. Never drop columns, rename tables, or add non-nullable columns without defaults in a single step.

### Phased Migration Lifecycle

```mermaid
flowchart LR
    A["Phase 1: Expand<br/>(Add columns / tables)"] --> B["Phase 2: Deploy Code<br/>(Reads/writes new schema)"]
    B --> C["Phase 3: Backfill<br/>(Migrate historical rows)"]
    C --> D["Phase 4: Contract<br/>(Drop deprecated assets)"]
```

1. **Phase 1: Expand (Schema Forward)**
   - Add new tables, nullable columns, or columns with static defaults.
   - Install new stored procedures / helper functions in `app_private`.
   - Never remove existing columns, functions, or triggers relied upon by current code.
2. **Phase 2: Application Release**
   - Deploy new code version. It reads and writes to new schema structures while tolerating legacy data.
   - Run health checks: verify `GET /api/health` reports status `ok`.
3. **Phase 3: Data Backfill**
   - Execute batched, non-locking background backfills for existing records.
4. **Phase 4: Contract (Deprecation)**
   - In a subsequent migration release (at least one release cycle later), remove deprecated columns or legacy compatibility triggers.

---

## 2. Migration Execution Procedure

### Pre-Deployment Verification (Staging Database)
Before running migrations in production, execute automated integration tests against an isolated PostgreSQL instance:
```bash
# 1. Start clean PostgreSQL container
docker run --name pg-test -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16-alpine

# 2. Run sequential migrations
for file in database/migrations/*.sql; do
  psql "postgresql://postgres:postgres@localhost:5432/postgres" -f "$file"
done

# 3. Verify health checks pass
npm test
```

### Production Migration Execution
1. Connect via restricted administrator role.
2. Run migration in an explicit transaction (`BEGIN; ... COMMIT;`).
3. Set statement timeout to avoid locking tables indefinitely:
   ```sql
   SET statement_timeout = '15s';
   SET lock_timeout = '5s';
   ```
4. Confirm health check:
   ```bash
   curl -sSf https://control-plane.cloudexify.com/api/health | jq .
   ```

---

## 3. Database Migration Rollback Runbook

If a migration fails or must be rolled back:

### Migration Rollback Table

| Migration | Forward Action | Safe Rollback Action (Down Script) |
|---|---|---|
| `022_acme_certificate_lifecycle.sql` | Adds `domain_tls_certificates` table | `DROP TABLE IF EXISTS public.domain_tls_certificates CASCADE;` |
| `021_persistent_application_volumes.sql` | Adds `application_volumes` and `volume_backups` | `DROP TABLE IF EXISTS public.volume_backups CASCADE; DROP TABLE IF EXISTS public.application_volumes CASCADE;` |
| `020_node_ingress_drain_state.sql` | Adds `ingress_draining` to `nodes` | `ALTER TABLE public.nodes DROP COLUMN IF EXISTS ingress_draining;` |
| `019_ingress_route_endpoint_version.sql` | Adds `route_version` tracking | `DROP TRIGGER IF EXISTS deployments_bump_route_version ON public.deployments;` |
| `018_activate_ingress_routes.sql` | Adds `active` state and activation trigger | `DROP TRIGGER IF EXISTS reconcile_route_activation ON public.nodes;` |

> [!WARNING]
> Do NOT drop tables containing active customer production data without validating that an automated backup exists in the backup vault.

---

## 4. Control Plane Application Rollback

Control-plane deployments run as serverless edge functions on Vercel:

1. **Instant Rollback via Vercel CLI:**
   ```bash
   # List recent production deployments
   vercel list --prod
   # Roll back to the previous verified deployment SHA
   vercel rollback <PREVIOUS_DEPLOYMENT_URL_OR_ID>
   ```
2. **Verify Control-Plane Health:**
   ```bash
   curl -sSf https://control-plane.cloudexify.com/api/health
   ```

---

## 5. Node Agent Rolling Upgrade Procedure

Node agents maintain active container processes independently of the daemon process.

1. **Drain Ingress Traffic (if gateway forwarder node):**
   ```http
   POST /api/v1/tenants/:tenantId/nodes/:nodeId/state
   Content-Type: application/json

   { "ingress_state": "draining" }
   ```
2. **Update Agent Binary / Code:**
   Pull latest verified release binary or Git commit onto the node.
3. **Restart Agent Daemon:**
   Restart the systemd service or background supervisor:
   ```bash
   systemctl restart cloudexify-agent
   ```
4. **Durable Container Reconnection:**
   On startup, the node agent queries rootless Podman containers, invokes `withNodeRuntimeReconciliation`, and confirms existing containers are running without downtime.
5. **Resume Ingress:**
   ```http
   POST /api/v1/tenants/:tenantId/nodes/:nodeId/state
   Content-Type: application/json

   { "ingress_state": "active" }
   ```

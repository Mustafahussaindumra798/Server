# Cloudexify Server — Disaster Recovery & Business Continuity Plan

This plan establishes the operational procedures for recovering the Cloudexify Server platform from major catastrophic events, including complete database destruction, datacenter loss, node failures, and gateway interruptions.

---

## 1. Objectives & Metrics (RTO / RPO)

| Subsystem | RPO (Recovery Point Objective) | RTO (Recovery Time Objective) | Backup Mechanism |
|---|---|---|---|
| **Control-Plane Database** | < 1 hour | < 30 minutes | Supabase continuous WAL archiving + daily logical `pg_dump` |
| **Node Workload Volumes** | < 24 hours | < 1 hour per volume | Incremental snapshots via `volume_backups` table / object storage |
| **Ingress Gateway Routing** | < 5 minutes | < 10 minutes | Database-backed route recovery + auto-generated certificates |
| **Identity & Access (Supabase)** | < 1 hour | < 15 minutes | Supabase Auth replica & backup configuration |

---

## 2. Disaster Recovery Scenarios & Playbooks

### Scenario A: Complete Database Destruction / Corruption

1. **Provision Fresh PostgreSQL Instance:**
   Ensure database meets minimum PostgreSQL 15+ specifications.
2. **Restore Latest Logical Backup:**
   ```bash
   psql "$NEW_DATABASE_URL" < backup-latest.sql
   ```
3. **Execute Point-in-Time Recovery (WAL):**
   Replay Write-Ahead Logs up to the point of failure if WAL archive is accessible.
4. **Run Migration Check & Health Verification:**
   ```bash
   curl -sSf https://control-plane.cloudexify.com/api/health | jq .
   ```
5. **Node Re-Registration & Heartbeat Synchronization:**
   Online nodes submit heartbeats within 30 seconds, automatically re-populating runtime capabilities and telemetry.

---

### Scenario B: Catastrophic Node Loss (Physical Hardware Destruction)

1. **Automatic Node Offline Detection:**
   The control plane marks nodes offline when `last_seen_at` is older than `heartbeat_interval_seconds * 3` (90 seconds).
2. **Ingress Route Suspension:**
   Ingress gateway automatically suspends traffic routing to the destroyed node via `reconcile_route_activation`.
3. **Workload Rescheduling:**
   The scheduler places replacement deployment revisions onto eligible healthy Linux nodes with sufficient CPU and memory capacity.
4. **Volume Restoration:**
   Attach replacement volume from latest snapshot in `volume_backups`:
   ```http
   POST /api/v1/tenants/:tenantId/volumes
   Content-Type: application/json

   {
     "application_id": "<APP_ID>",
     "name": "data-restored",
     "mount_path": "/var/lib/data",
     "size_bytes": 10737418240
   }
   ```
5. **Decommission Destroyed Node:**
   Revoke node credentials permanently:
   ```http
   POST /api/v1/tenants/:tenantId/nodes/:nodeId/reject
   ```

---

### Scenario C: Ingress Gateway Failure / Datacenter Outage

1. **DNS Failover:**
   Switch public DNS `A`/`AAAA` records to secondary hot-standby gateway IP.
2. **Re-establish Outbound Node Tunnels:**
   Node agents maintain automatic reconnection backoff to gateway endpoints. When DNS points to the secondary gateway, nodes establish mTLS reverse tunnels within 60 seconds.
3. **Re-hydrate Route Registry:**
   The secondary gateway reads active routes from `deployment_domain_routes` and begins routing HTTPS traffic once tunnels open.

---

## 3. Disaster Recovery Testing Drills

- **Quarterly Tabletop Simulation:** Walk through complete database loss scenario with operations team.
- **Bi-annual Node Eviction Drill:** Intentionally terminate an active execution node hosting running applications and verify automatic workload recovery and ingress draining within 180 seconds.
- **Monthly Volume Restore Drill:** Spin up a temporary application using a restored volume backup to verify checksum and file integrity.

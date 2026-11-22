# Node heartbeat API

The node agent sends an outbound HTTPS request and does not open an inbound management port.

## Request

POST /api/v1/nodes/{node_id}/heartbeat

Headers: Authorization: Bearer <node-credential>; Content-Type: application/json.

Example body:

    { "agent_version": "0.1.0", "health_status": "healthy", "resources": { "cpu_percent": 21.5, "memory_total_bytes": 8589934592, "memory_used_bytes": 3221225472, "uptime_seconds": 3600 } }

Health must be healthy or degraded. Resource metrics are optional numeric values from the allowlist: cpu_percent, memory_total_bytes, memory_used_bytes, disk_total_bytes, disk_available_bytes, load_1m, uptime_seconds, battery_percent and temperature_c. Unknown keys, non-finite/negative values, CPU/battery percentages above 100, more than nine metrics, and payloads over 8 KiB are rejected.

## Authentication and persistence

The API hashes the presented credential with SHA-256 and passes only the hash to a SECURITY DEFINER database function. The function checks node ID, credential hash, revocation, expiry and node revocation state atomically. It updates credential last-use time, node last-seen time, agent version, resource metrics and health status. Secrets and hashes are not returned.

A node remains pending until a tenant Owner or Admin approves it from the dashboard or API; heartbeat receipt does not implicitly approve a device. Approval is tenant-scoped and audited. If the node has a heartbeat within three configured intervals, approval changes its status to online; otherwise it becomes offline until its next heartbeat. Rejecting a pending node revokes all active node credentials and marks the node revoked. Rejected/revoked nodes cannot be re-approved or reconnect with those credentials.

## Stale-node detection

The default heartbeat interval is 60 seconds (database constraint: 15–300 seconds). Tenant node-list API reports offline when no heartbeat has arrived or last_seen_at is older than three configured intervals. This is derived at read time; no background worker is introduced.

## Runtime database permissions

Explicitly grant the runtime DB role EXECUTE on app_private.accept_node_heartbeat(uuid,text,text,text,jsonb). Keep the role non-owner, non-superuser and without BYPASSRLS. The function uses a fixed search path and is not executable by PUBLIC.

## Limitations

This implements the control-plane endpoint, not a packaged node agent or production deployment. TLS termination, rate limiting, credential rotation, alerting and production DB/runtime-role provisioning remain deployment requirements.

## Approval API

- `POST /api/v1/tenants/{tenant_id}/nodes/{node_id}/approve` — Owner/Admin only; sets `approved_at` and brings a recently seen node online.
- `POST /api/v1/tenants/{tenant_id}/nodes/{node_id}/reject` — Owner/Admin only; revokes active credentials and marks the pending node revoked.
- Both operations lock the tenant-scoped node row and append an audit event. Only pending nodes can be acted on; revoked nodes are terminal.
- The dashboard exposes Approve/Reject controls only to Owner/Admin users on pending node rows.

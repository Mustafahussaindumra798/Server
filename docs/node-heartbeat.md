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

A node remains pending until an approval workflow sets approved_at; heartbeat receipt does not implicitly approve a device. Approved nodes become online or degraded according to the health report.

## Stale-node detection

The default heartbeat interval is 60 seconds (database constraint: 15–300 seconds). Tenant node-list API reports offline when no heartbeat has arrived or last_seen_at is older than three configured intervals. This is derived at read time; no background worker is introduced.

## Runtime database permissions

Explicitly grant the runtime DB role EXECUTE on app_private.accept_node_heartbeat(uuid,text,text,text,jsonb). Keep the role non-owner, non-superuser and without BYPASSRLS. The function uses a fixed search path and is not executable by PUBLIC.

## Limitations

This implements the control-plane endpoint, not a packaged node agent or production deployment. TLS termination, rate limiting, credential rotation, alerting and production DB/runtime-role provisioning remain deployment requirements.

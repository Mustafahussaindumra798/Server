# Node heartbeat API

The node agent sends an outbound HTTPS request and does not open an inbound management port.

## Request

POST /api/v1/nodes/{node_id}/heartbeat

Headers: Authorization: Bearer <node-credential>; Content-Type: application/json.

Example body:

    {
      "agent_version": "0.1.0",
      "health_status": "healthy",
      "resources": {
        "cpu_cores": 8,
        "cpu_percent": 21.5,
        "cpu_frequency_mhz": 1800,
        "memory_total_bytes": 8589934592,
        "memory_used_bytes": 3221225472,
        "memory_available_bytes": 5368709120,
        "disk_total_bytes": 128000000000,
        "disk_used_bytes": 64000000000,
        "disk_available_bytes": 64000000000,
        "android_shared_storage_total_bytes": 128000000000,
        "android_shared_storage_used_bytes": 40000000000,
        "android_shared_storage_available_bytes": 88000000000,
        "uptime_seconds": 3600
      }
    }

Health must be healthy or degraded. All resource metrics are optional numeric values from the allowlist: cpu_percent, cpu_cores, cpu_frequency_mhz, memory_total_bytes, memory_used_bytes, memory_available_bytes, disk_total_bytes, disk_used_bytes, disk_available_bytes, android_shared_storage_total_bytes, android_shared_storage_used_bytes, android_shared_storage_available_bytes, load_1m, uptime_seconds, battery_percent and temperature_c. The agent omits metrics it cannot read; it never fabricates values.

RAM used is calculated as total minus MemAvailable, and RAM available is reported separately. Agent filesystem capacity is measured at the agent's data filesystem (Termux PREFIX on Android, root filesystem on Linux). Android shared storage at /storage/emulated/0 is reported separately and only when the user has granted Termux storage access. These are separate mount views and must not be added together. Disk used is total minus filesystem free blocks; disk available reflects unreserved blocks available to the agent.

The API accepts up to 20 finite numeric metrics in a 16 KiB payload. Capacity triples must be internally consistent; CPU cores must be 1–256, CPU/battery percentages 0–100, CPU frequency at most 10,000 MHz and temperature at most 150 °C. Unknown keys and malformed values are rejected. Resource admission requires fresh cpu_cores, cpu_percent, memory_available_bytes and disk_available_bytes telemetry.

## Authentication and persistence
The heartbeat body also includes a `capabilities` JSON object (maximum 8 KiB). It reports the agent protocol, supported diagnostic handlers, service manager and runtime probe results. The agent refreshes this object on every heartbeat so Podman installation/removal and cgroup changes are reflected without re-enrollment. Migration `008_runtime_capability_heartbeat.sql` adds a six-argument authenticated heartbeat function that updates `nodes.capabilities_json`; the original five-argument function remains available for older agents. Capability values are node-reported observations, not authorization by themselves. `workload_execution` remains false until the separate workload executor is implemented and qualified.


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

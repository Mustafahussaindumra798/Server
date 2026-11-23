# Cloudexify Server — Operational Alert Definitions & Metrics Specification

This document defines the production alert conditions, thresholds, severity tiers, PromQL expressions, and immediate remediation runbooks for the Cloudexify Server control plane and node infrastructure.

---

## 1. Severity Levels

| Severity | Name | Description | Response Time | Notification Channel |
|---|---|---|---|---|
| **P1** | Critical | Service outage, active data loss, security compromise, or complete scheduler stall. | Immediate (< 15m) | PagerDuty / On-Call Phone |
| **P2** | Warning | Degraded redundancy, elevated failure rate, approaching quota, or stale nodes. | < 2 hours | Slack `#alerts-ops` / PagerDuty |
| **P3** | Info / Low | Informational trends, scheduled certificate auto-renewal notifications. | Next business day | Slack `#ops-notifications` |

---

## 2. Core Alert Conditions

### Alert 1: Stale Job Leases Detected
- **Condition:** Node leases that have exceeded `lease_expires_at` without reaching a terminal acknowledgement (`succeeded`, `failed`, `rejected`).
- **Severity:** P2 (Warning) if stale count > 0 for 5 minutes; P1 (Critical) if stale count > 10.
- **Metric / SQL:**
  ```sql
  SELECT count(*) FROM jobs
  WHERE status IN ('leased', 'running')
    AND lease_expires_at < clock_timestamp() - interval '2 minutes';
  ```
- **PromQL:** `cloudexify_jobs_stale_leases_count > 0`
- **Impact:** Jobs remain locked and cannot be retried or completed, stalling deployment rollouts or diagnostic probes.
- **Remediation:** Inspect node connectivity for the assigned node. If node is offline, verify `app_private.reconcile_node_deployments` or lease reaper function resets the job attempt count.

---

### Alert 2: Deployment Rollback / Deployment Terminal Failure
- **Condition:** An active deployment enters `failed` or `rolled_back` state due to container startup failure, image signature mismatch, or HTTP health check timeout.
- **Severity:** P2 (Warning) on single rollback; P1 (Critical) if consecutive failures occur on the same application (`failed_deployments_rate > 10%`).
- **Metric / SQL:**
  ```sql
  SELECT count(*) FROM deployments
  WHERE status = 'failed'
    AND updated_at > clock_timestamp() - interval '15 minutes';
  ```
- **PromQL:** `rate(cloudexify_deployments_failed_total[15m]) > 0`
- **Impact:** Application revision not serving traffic; automatic rollback to previous revision activated.
- **Remediation:**
  1. Inspect deployment audit events: `GET /api/v1/tenants/:id/deployments/:id/events`.
  2. Inspect container exit code and loopback HTTP health check output.
  3. Verify Cosign signature readiness on the target node.

---

### Alert 3: Node Disconnect / Offline Without Graceful Drain
- **Condition:** An approved node has not submitted a heartbeat within `heartbeat_interval_seconds * 3` while holding active deployment workloads.
- **Severity:** P1 (Critical) if holding active deployment workloads; P2 (Warning) if holding diagnostic probes only.
- **Metric / SQL:**
  ```sql
  SELECT count(*) FROM nodes
  WHERE status = 'online'
    AND approved_at IS NOT NULL
    AND last_seen_at < clock_timestamp() - make_interval(secs => heartbeat_interval_seconds * 3);
  ```
- **PromQL:** `cloudexify_nodes_unexpected_offline_count > 0`
- **Impact:** Workloads hosted on the node become unreachable; reverse ingress tunnel disconnects.
- **Remediation:**
  1. Check host machine power, networking, and daemon process.
  2. Gateway automatically suspends ingress routes bound to this node.
  3. Re-schedule active workloads onto healthy online Linux nodes.

---

### Alert 4: TLS Certificate Approaching Expiry
- **Condition:** Active domain TLS certificate has `not_after < now() + interval '30 days'` and `auto_renew = false`, or `not_after < now() + interval '7 days'` with renewal failures.
- **Severity:** P2 (Warning) at 30 days; P1 (Critical) at 7 days.
- **Metric / SQL:**
  ```sql
  SELECT count(*) FROM domain_tls_certificates
  WHERE status = 'active'
    AND not_after < clock_timestamp() + interval '7 days';
  ```
- **PromQL:** `cloudexify_domain_tls_expiry_seconds < 604800`
- **Impact:** Risk of browser security warnings and broken public ingress HTTPS connections.
- **Remediation:**
  1. Trigger ACME renewal worker: check Let's Encrypt / ZeroSSL challenge resolution.
  2. Verify DNS TXT record or HTTP-01 challenge reachability.

---

### Alert 5: Job Queue Depth & Scheduling Backpressure
- **Condition:** Number of `queued` jobs exceeds 50 for more than 5 minutes, indicating no available nodes or scheduler saturation.
- **Severity:** P2 (Warning).
- **Metric / SQL:**
  ```sql
  SELECT count(*) FROM jobs
  WHERE status = 'queued'
    AND created_at < clock_timestamp() - interval '5 minutes';
  ```
- **PromQL:** `cloudexify_jobs_queued_backlog_duration_seconds > 300`
- **Impact:** New deployment and diagnostic tasks delayed.
- **Remediation:**
  1. Check if eligible nodes have sufficient unreserved CPU millicores and memory bytes.
  2. Enroll additional Linux execution nodes.

---

### Alert 6: Per-User API Rate Limit Violations / Login Abuse
- **Condition:** An authenticated user or client IP generates > 30 rate-limited (HTTP 429) responses per minute.
- **Severity:** P2 (Warning).
- **PromQL:** `rate(cloudexify_http_requests_total{status="429"}[1m]) > 0.5`
- **Impact:** Potential credential brute-force, scraping, or misconfigured polling client.
- **Remediation:**
  1. Review client IP address and user-agent from structured logs.
  2. Temporarily ban abusive IP at edge firewall / CDN if malicious.

---

### Alert 7: Volume Storage Quota Exceeded
- **Condition:** Host overlay filesystem or persistent application volume reaches > 85% disk utilization.
- **Severity:** P2 (Warning) at 85%; P1 (Critical) at 95%.
- **Metric / SQL:**
  ```sql
  SELECT count(*) FROM nodes
  WHERE (capabilities_json #>> '{runtime_probe,podman,storage_quota,available_bytes}')::bigint < 5368709120;
  ```
- **Impact:** Podman fails to create rootless container writable overlay layers; container operations fail closed.
- **Remediation:** Run volume cleanup, purge stopped container layers, or resize underlying host partition.

---

## 3. Operational Health Check API

The operational health of these components can be queried via:
```http
GET /api/health?detail=full HTTP/1.1
```

Response includes consolidated counts for:
- `job_queue`: `queued`, `active`, `failed`, `stale_leases`
- `deployments`: `healthy`, `active`, `failed`
- `nodes`: `online`, `offline`, `draining`
- `storage`: `total_volumes`, `completed_backups`

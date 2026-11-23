# Safe node jobs

**Status:** Control-plane job creation, credential-authenticated polling, leases, acknowledgements and retry reconciliation are implemented. A packaged node agent and workload execution adapters are not included.

## Application lifecycle reconciliation

`POST /api/v1/tenants/:tenantId/applications/:applicationId/state` accepts `running`, `stopped` or `suspended` desired state for Owner/Admin roles.

- Application state changes lock the application row first, matching the deployment-creation lock order.
- A stop or suspend request locks the application's deployment revisions and cancels only `queued` / `scheduled` revisions.
- If any revision is already `deploying` or `healthy`, the API returns HTTP 409 and changes nothing. A node runtime is required to stop an active workload safely.
- Cancellation and application state changes share the user transaction; a failure rolls back both.
- Audit events record the requested state and the number of cancelled revisions.
- This is control-plane intent and queue reconciliation only. It does not claim that a process was started or stopped; runtime execution remains disabled.

## Safety boundary

The first protocol version enables only two non-mutating job types:

- `probe` — request a bounded node connectivity/health probe.
- `collect_metrics` — request a bounded resource snapshot.

Both currently require an empty JSON payload. The API rejects arbitrary job types and non-empty payloads. Shell commands, executable paths, scripts, argv arrays, and user-supplied command strings are never accepted. The existing database enum values for deploy/stop/restart are not enabled by this API; those require dedicated typed execution adapters and separate review.

## User API

All user routes require an OIDC access token and an active tenant membership.

| Method | Route | Permission |
|---|---|---|
| GET | `/api/v1/tenants/:tenantId/jobs` | Any active tenant role |
| POST | `/api/v1/tenants/:tenantId/jobs` | Owner, Admin, Operator |

Create a job:

```json
{
  "node_id": "30000000-0000-4000-8000-000000000001",
  "type": "probe",
  "payload": {},
  "idempotency_key": "probe-node-a-01"
}
```

A target node must belong to the tenant, be approved, and have a recent online/degraded heartbeat. Idempotency keys are scoped to tenant + node. Reusing a key with the same type/payload returns the existing job; reusing it for different content returns HTTP 409.

## Node agent API

Node routes use the per-node credential in `Authorization: Bearer <node-credential>`. The API hashes the credential before database verification. A credential cannot poll another node's queue.

### Claim jobs

`POST /api/v1/nodes/:nodeId/jobs/claim`

Optional bounded body:

```json
{ "limit": 1, "lease_seconds": 60 }
```

Limits: 1–10 jobs per poll and 15–300 seconds per lease. A successful claim returns a unique attempt ID and lease token for each job. The lease token is a short-lived bearer value and must be kept in memory by the agent; do not log it.

### Acknowledge a job

`POST /api/v1/nodes/:nodeId/jobs/:jobId/ack`

```json
{
  "attempt_id": "70000000-0000-4000-8000-000000000001",
  "lease_token": "80000000-0000-4000-8000-000000000001",
  "status": "succeeded",
  "result_code": "ok",
  "result_summary": "Diagnostic completed"
}
```

Allowed transitions are `leased → accepted → running → succeeded`, with `failed` and `rejected` terminal/reconciliation outcomes. A failed attempt is re-queued with bounded exponential backoff until the five-attempt limit; rejected jobs are terminal. A stale, expired, superseded, or wrong-node lease cannot update the job. Result summaries are limited to 4,000 characters.

## Database and operational guarantees

Migration: `database/migrations/005_safe_node_jobs.sql`.

- Claims use row locks with `SKIP LOCKED`, so concurrent pollers cannot receive the same queued attempt.
- Each claim creates a distinct `job_attempts` row and rotates the lease token.
- Expired leases close their attempt and reconcile to queued or failed based on the attempt limit.
- Acknowledgements verify the node credential, node/job/attempt binding, lease token, active status, and unexpired lease.
- Job creation and node lifecycle transitions append audit events.
- Agent-facing database operations use narrowly scoped SECURITY DEFINER functions with a fixed search path. PUBLIC execute is revoked; explicitly grant the runtime role the function permissions.

The current API only queues diagnostic job types. It does not execute work itself. A future agent must implement each typed operation as a local, bounded handler; it must never translate job data into shell execution. Mutating application lifecycle actions, cancellation, scheduling, and production rate limiting remain future work.

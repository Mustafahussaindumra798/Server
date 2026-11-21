# Control-plane backend design

**Status:** Architecture proposal; not implemented.
**Scope:** Backend foundation, identity, tenant boundaries, node enrollment, heartbeat, command delivery and persistence.
**Principles:** Secure by default, outbound-only node connectivity, explicit desired state, auditable operations, and best-effort classification for Android/Termux nodes.

## 1. Architecture decisions

| Area | Initial design | Reason |
|---|---|---|
| Control-plane API | Node.js, TypeScript, versioned REST API | Fits the current JavaScript/Node repository and is straightforward to test. |
| Primary database | PostgreSQL | Transactions, constraints, relational ownership and durable state. |
| Database access | Repository/data-access layer plus migrations | Keeps business logic independent of a hosting provider. |
| User authentication | OIDC-compatible user identity; short-lived API access tokens | Avoids inventing password storage and supports future identity providers. |
| Agent authentication | Unique credential per node, exchanged during one-time enrollment | A compromised node must not expose the whole fleet. |
| Agent transport | Outbound HTTPS polling for v1 | Works behind NAT and is more tolerant of mobile networks than inbound connections. |
| Events | Persisted event records; SSE for dashboard updates later | Durable history must not depend on a live browser connection. |
| Secrets | Dedicated secret store/KMS in production; encrypted secret references in database | Do not store plaintext deployment secrets in ordinary tables. |

These are proposed defaults, not vendor commitments. Supabase or another PostgreSQL provider can be evaluated during implementation, but the control-plane must not depend on provider-specific auth or database behavior in its domain model.

## 2. Logical components

1. **API gateway / HTTP server:** request parsing, API versioning, rate limits, request IDs and response envelopes.
2. **Identity and authorization:** user sessions, service identities, tenant membership and role checks.
3. **Node registry:** enrollment, ownership, capabilities, status, credential rotation and revocation.
4. **Desired-state service:** stores requested node and workload state; never treats a browser-side simulation as actual state.
5. **Agent communication service:** issues short-lived agent access, accepts heartbeats and leases pending jobs.
6. **Job dispatcher:** creates typed, scoped jobs and records acknowledgements/results. It does not execute arbitrary shell commands.
7. **Audit and event service:** append-only security-relevant actions and operational state transitions.
8. **Persistence layer:** PostgreSQL migrations, transactions, indexes and retention policies.

Keep these as modules in the first deployable service. Split into separate processes only when scale or isolation requirements justify it.

## 3. Tenant and authorization model

Every customer-owned resource is scoped by `tenant_id`. A user may belong to multiple tenants through a membership record. The API derives tenant context from the authenticated principal and membership; it must never trust a client-supplied tenant ID without authorization.

Initial roles:
- **owner:** tenant settings, members, nodes, applications, billing-related settings later.
- **admin:** manage nodes, applications and deployments; manage members except ownership transfer.
- **operator:** inspect resources and perform approved operational actions.
- **viewer:** read-only access.

Platform administration is a separate, tightly restricted role and must not be implied by tenant ownership.

Authorization checks happen server-side on every resource access and action. Database row-level security can provide defense in depth, but it does not replace application authorization. Cross-tenant access tests are release blockers.

## 4. Proposed PostgreSQL data model

Use UUID primary keys, UTC timestamps, foreign keys, explicit status enums/check constraints, and migrations. Add `created_at` and `updated_at` to mutable records. Use soft deletion only where recovery or audit requirements need it.

### Identity and tenancy

| Table | Important columns | Purpose |
|---|---|---|
| `users` | `id`, `identity_subject`, `email`, `display_name`, `created_at` | Maps external identity-provider subject to Cloudexify user. |
| `tenants` | `id`, `name`, `slug`, `status` | Customer or organization boundary. |
| `tenant_memberships` | `tenant_id`, `user_id`, `role`, `status` | User membership and role; unique tenant/user pair. |

### Nodes and credentials

| Table | Important columns | Purpose |
|---|---|---|
| `nodes` | `id`, `tenant_id`, `name`, `platform`, `architecture`, `agent_version`, `status`, `last_seen_at`, `capabilities_json` | Registered independent compute device. |
| `node_credentials` | `id`, `node_id`, `secret_hash`, `issued_at`, `expires_at`, `revoked_at`, `last_used_at` | Per-node credential metadata; persist only a verifier/hash, never the reusable plaintext secret. |
| `enrollment_tokens` | `id`, `tenant_id`, `token_hash`, `expires_at`, `used_at`, `created_by` | Short-lived, single-use enrollment authorization. |

Node status is derived from persisted lifecycle state and heartbeat freshness, not from a device's self-reported status alone. Suggested states: `pending`, `online`, `degraded`, `offline`, `revoked`. A periodic server-side evaluator marks a node stale after its configured heartbeat grace period.

### Workload control and operations

| Table | Important columns | Purpose |
|---|---|---|
| `applications` | `id`, `tenant_id`, `name`, `desired_state`, `created_by` | Customer application metadata. |
| `deployments` | `id`, `tenant_id`, `application_id`, `revision`, `target_node_id`, `desired_state`, `status`, `created_at` | Immutable deployment revision and lifecycle. |
| `jobs` | `id`, `tenant_id`, `node_id`, `deployment_id`, `type`, `payload_json`, `status`, `lease_expires_at`, `attempt_count`, `idempotency_key` | Typed work item delivered to one node. |
| `job_attempts` | `id`, `job_id`, `node_id`, `started_at`, `finished_at`, `result_code`, `result_summary` | Execution history without storing secrets in logs. |
| `audit_events` | `id`, `tenant_id`, `actor_type`, `actor_id`, `action`, `resource_type`, `resource_id`, `request_id`, `metadata_json`, `created_at` | Append-only record of security-sensitive actions. |

### Data rules

- Add indexes for tenant-scoped lookups, node heartbeat timestamps, job status/lease expiry and deployment history.
- Enforce foreign keys and unique constraints, including unique enrollment token hashes and idempotency keys within their intended scope.
- Use transactions when changing desired state and creating the corresponding job/event.
- Do not store raw passwords, enrollment tokens, agent secrets, private keys, or application secret values in these tables.
- Treat `capabilities_json` and job results as untrusted input; validate schema, size and allowed fields.
- Define retention and deletion rules before storing high-volume telemetry. Heartbeat samples should not become an unbounded audit log.

## 5. Enrollment and trust lifecycle

1. An authorized tenant owner/admin creates a short-lived enrollment token. The server stores only its hash and returns the plaintext once.
2. The device agent connects outbound to the control plane over HTTPS and submits the token plus validated device metadata.
3. The server atomically verifies expiry and unused state, consumes the token, creates a pending node and issues a unique node credential. A token must not enroll multiple devices.
4. The agent stores its credential in the best available OS-protected location. On Android/Termux, storage protections are weaker; document that risk and never claim hardware-backed protection unless verified.
5. The agent authenticates subsequent requests using its node-specific credential and receives a short-lived access token scoped to that node.
6. The owner/admin approves or rejects the node if policy requires approval. Only approved nodes may receive workload jobs.
7. Credential rotation issues a replacement, confirms the new credential works, then revokes the old credential. Revocation takes effect immediately at the API.
8. Node removal revokes credentials and stops new job leases. Any already-running workload requires an explicit stop/reconciliation policy.

Never put a fleet-wide secret in the application, bootstrap script, mobile package, Git repository or image.

## 6. Agent communication protocol (v1)

Use outbound HTTPS only. A node does not open a public inbound management port.

Proposed endpoints:

| Method and route | Caller | Purpose |
|---|---|---|
| `POST /api/v1/agent/enroll` | New agent | Consume enrollment token and issue node identity. |
| `POST /api/v1/agent/token` | Enrolled agent | Exchange node credential for short-lived access token. |
| `POST /api/v1/agent/heartbeat` | Agent | Report health, capacity and agent version. |
| `POST /api/v1/agent/jobs/lease` | Agent | Lease one eligible job for this node. |
| `POST /api/v1/agent/jobs/:id/ack` | Agent | Acknowledge accepted/rejected job. |
| `POST /api/v1/agent/jobs/:id/result` | Agent | Submit bounded, validated job result. |
| `POST /api/v1/agent/credentials/rotate` | Agent | Rotate its own credential. |

Dashboard/user endpoints live separately under `/api/v1/` and require user identity plus tenant authorization. Agent endpoints must reject user tokens; user endpoints must reject agent tokens.

### Heartbeat contract

Agent request fields should be limited to:
- `agent_version`, `platform`, `architecture`
- `uptime_seconds`
- `resources`: total/available memory, CPU count/load where supported, disk capacity/free space
- `runtime_capabilities`: explicitly detected features, not guessed features
- `network`: coarse connectivity/egress status, no unnecessary location collection
- `observed_at`: device timestamp for diagnostics only

The server sets authoritative `received_at` and updates `last_seen_at`. Do not trust device clocks for authentication or ordering. Validate numeric ranges, cap payload sizes, rate-limit heartbeats and discard unknown fields. Missing optional metrics must be represented as unavailable, not fabricated as zero.

Suggested starting interval: 30–60 seconds on stable Linux nodes, with exponential backoff and jitter during failures. Android agents should use a configurable slower interval and may be suspended by the OS. Mark stale nodes offline only after a grace period (for example, 3 missed intervals plus network tolerance); tune from observed behavior.

### Job leasing and delivery

- The server selects jobs already assigned to the authenticated node; an agent cannot request jobs for another node.
- A lease has an expiry. If the agent disappears before acknowledgement, the job can be re-queued according to bounded retry policy.
- Use a stable idempotency key and job ID. Agent handlers must make repeated delivery safe.
- Job payloads use a strict versioned schema and an allowlisted `type`; never accept arbitrary shell strings as a job type.
- Acknowledge states such as `accepted`, `rejected`, `running`, `succeeded`, `failed`, `cancelled` with server-validated transitions.
- Store bounded result summaries and structured error codes. Do not upload environment variables, credentials or unrestricted command output.

## 7. API conventions

- Prefix all public endpoints with `/api/v1`; make breaking changes under a new version.
- Use JSON request/response bodies, UTC ISO-8601 timestamps, UUID identifiers and consistent error objects.
- Require request IDs, structured logs and pagination for collection endpoints.
- Use optimistic concurrency/version fields for mutable desired-state resources.
- Require idempotency keys for create/deploy/command operations that clients may retry.
- Apply per-user, per-tenant and per-node rate limits.
- Return generic authentication errors; do not reveal whether another tenant's resource exists.

Example error shape:

```json
{
  "error": {
    "code": "NODE_NOT_APPROVED",
    "message": "This node is not approved to receive jobs.",
    "request_id": "request-uuid"
  }
}
```

## 8. Security baseline

- TLS for all network traffic; consider mutual TLS in a later hardening phase, not as an assumption for every Android environment.
- Short-lived user and agent access tokens; separate issuers/audiences/scopes.
- Hash one-time enrollment tokens and stored node credential verifiers using a suitable cryptographic design; compare secrets in constant time.
- Encrypt sensitive values at rest using a managed KMS/secret manager. Keep encryption keys outside the database.
- Strict tenant isolation, role checks, input validation, output encoding, CSRF protection for cookie-based browser sessions, secure cookies and CORS allowlists.
- Rate limits and abuse controls on enrollment, token exchange, heartbeat and job endpoints.
- Audit enrollment, approval, credential rotation/revocation, membership changes, deployment requests and privileged actions.
- No arbitrary remote shell in v1. Define a typed, minimal job vocabulary and validate every parameter.
- Define backup, restore, incident response, dependency updates and vulnerability reporting before production.

## 9. Failure behavior and operational policy

- **Control plane unreachable:** agents keep current safe state; they do not invent new desired state. They retry with exponential backoff and jitter.
- **Heartbeat delayed:** node becomes stale/offline after server-side grace period; do not immediately delete or mark workloads failed.
- **Duplicate job:** idempotency prevents duplicate side effects.
- **Agent crash:** lease expires; server may retry only if job policy says it is safe.
- **Credential suspected compromised:** revoke node credential, deny new leases, record audit event and require re-enrollment.
- **Node capacity drops:** stop new placement; do not kill existing workloads unless an explicit policy requires it.
- **Database unavailable:** fail closed for privileged actions and do not issue new leases from stale authorization state.

## 10. Android / Termux support boundary

Treat Android/Termux as an experimental, best-effort node profile:
- no production uptime guarantee;
- Android may suspend or terminate background execution;
- battery saver, thermal throttling, storage and network transitions affect capacity;
- do not assume Docker, systemd, kernel modules or privileged networking;
- advertise only capabilities the agent has actually probed;
- default to low resource reservations and non-critical workloads.

A standard Linux server is the first production-oriented node target. An Android phone remains an independent node; multiple phones do not become one shared-memory machine.

## 11. Implementation sequence (not part of this design-only task)

1. Select hosting/runtime and PostgreSQL provider after a deployment/security review.
2. Create migrations and tenant-scoped repository layer.
3. Implement user identity, membership and RBAC with cross-tenant tests.
4. Implement one-time enrollment and node credential lifecycle.
5. Implement heartbeat persistence and stale-node evaluator.
6. Implement job leasing with allowlisted no-op/test job types.
7. Add integration, abuse, revocation, replay, concurrency and failure tests.
8. Only then implement real workload execution and scheduling.

## 12. Acceptance criteria before real devices connect

- A user from tenant A cannot read or mutate tenant B data.
- Enrollment tokens are single-use, expire, and cannot be replayed.
- Each node has an independent revocable credential.
- Revoked nodes cannot heartbeat successfully or lease new jobs.
- Heartbeats are validated, rate-limited and persisted with server receipt time.
- Duplicate requests and job deliveries do not duplicate side effects.
- Agents make outbound connections only; no public node-control port is required.
- Arbitrary shell execution is absent from the v1 protocol.
- Audit records exist for privileged operations.
- Tests cover offline nodes, expired leases, replay, rate limits and database failure.
- Android/Termux limitations are visible in the product and support matrix.

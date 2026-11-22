# Delivery roadmap and implementation checklist

**Current stage:** Milestone 2 — node enrollment, heartbeat backend, and safe typed diagnostic job protocol are CI-verified. Linux node agent v0.1.0 is implemented and its Ubuntu/Node compatibility matrix is CI-verified; no production certification is claimed.

## Milestone 0 — Dashboard prototype
- [x] Responsive dashboard shell and navigation
- [x] Simulated node and application inventory
- [x] Sample node registration interaction
- [x] Local static server and health endpoint
- [ ] Browser-based visual QA across target devices

## Milestone 1 — Control-plane foundation
- [x] Versioned API contract and control-plane architecture documented
- [x] PostgreSQL schema and initial RLS migration
- [x] PostgreSQL runtime migration/RLS integration checks in GitHub Actions
- [x] OIDC RS256 access-token verification using trusted JWKS
- [x] Issuer, audience, expiry, not-before and HTTPS endpoint validation
- [x] Database-backed identity resolution using issuer + subject
- [x] Transaction-local user context for pooled PostgreSQL connections
- [x] Tenant membership and Owner/Admin/Operator/Viewer RBAC
- [x] Protected APIs for current user, tenant listing, applications, deployments and members
- [x] Audit events for application, deployment and membership creation
- [x] API, OIDC and RBAC automated tests
- [ ] Configure a real OIDC provider and provision the first owner through a controlled bootstrap
- [ ] Provision a live PostgreSQL runtime role and deployment environment
- [ ] Production hardening: distributed rate limits, monitoring, secrets management and security review

**Verification:** GitHub Actions run [#55](https://github.com/danyalbut96-khan/Server/actions/runs/44976273422) passed on `main` commit `e7dc87b8f6dcbced724f2f97b921e8b7f114a8ce`. It applied migrations 001–005, passed PostgreSQL integration checks for node job leases/retries/stale acknowledgements, and passed the application test suite against disposable PostgreSQL 16 CI infrastructure. Earlier heartbeat verification is recorded in run [#29](https://github.com/danyalbut96-khan/Server/actions/runs/44974907250).

## Milestone 2 — Node enrollment and agent
- [x] One-time, high-entropy enrollment token issuance with configurable expiry
- [x] Store only SHA-256 enrollment-token hashes
- [x] Atomic, single-use enrollment consumption in PostgreSQL
- [x] Pending node registration with validated platform and capabilities
- [x] Issue per-node 90-day credential; store only its SHA-256 hash
- [x] Return node credential secret only once at enrollment
- [x] Tenant-scoped Owner/Admin credential revocation and audit events
- [x] Revoke node status when its last active credential is revoked
- [x] PostgreSQL integration coverage for successful, expired and replayed enrollment tokens
- [x] API tests for token permissions, token hashing, enrollment response and credential revocation
- [x] Define supported OS/runtime matrix and qualification gates (Linux first; Android/Termux best-effort; Windows/macOS planned)
- [x] Build authenticated node heartbeat endpoint for outbound agents
- [x] Add bounded health/resource reporting and server-side last-seen tracking
- [x] Derive offline status after three missed heartbeat intervals
- [x] Test invalid, expired and revoked credentials and cross-node credential isolation
- [x] Add strict typed diagnostic allowlist (`probe`, `collect_metrics`); reject arbitrary shell commands and non-empty payloads
- [x] Add tenant-scoped job creation/listing with Owner/Admin/Operator authorization and idempotency keys
- [x] Add credential-authenticated node job polling with bounded batch and lease parameters
- [x] Add unique attempt IDs, lease tokens, and guarded acknowledgement state transitions
- [x] Reconcile expired leases and retry failed attempts with bounded backoff and a five-attempt limit
- [x] Add API and PostgreSQL integration coverage for permissions, cross-node isolation, retries and stale leases

See [Safe node jobs](node-jobs.md) for the protocol contract and security boundary.

## Milestone 3 — Scheduler and deployment lifecycle
- [ ] Resource admission and placement policy
- [ ] Deployment revisions, health gates, rollback and event stream
- [ ] Per-node workload isolation and quotas

## Milestone 4 — Networking and operations
- [ ] Domain routing, TLS, service discovery and ingress
- [ ] Logs, metrics, alerts, backups and recovery drills
- [ ] Upgrade strategy and credential rotation

## Release gates
No production claim until automated tests, threat model, restore test, failure testing and documented support matrix pass. Android/Termux nodes must be explicitly labeled best-effort.

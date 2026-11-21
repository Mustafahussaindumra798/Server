# Delivery roadmap and implementation checklist

**Current stage:** Milestone 1 — authentication and tenant RBAC foundation implemented and CI-verified. No live customer database or identity provider is connected.

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

**Verification:** Latest green GitHub Actions run applied both migrations to PostgreSQL 16, passed the PostgreSQL identity/RLS integration script, and passed all 23 Node.js tests. The database was disposable CI infrastructure.

## Milestone 2 — Node agent
- [ ] Define supported OS/runtime matrix
- [ ] Build outbound authenticated enrollment and heartbeat
- [ ] Add node capability and resource reporting
- [ ] Add safe command allowlist and job reconciliation

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

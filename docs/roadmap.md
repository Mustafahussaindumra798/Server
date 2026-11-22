# Delivery roadmap and implementation checklist

**Current stage:** Milestone 2 — node enrollment, heartbeat backend, safe typed diagnostic jobs, and Linux/Termux agent foundations are implemented. Production login has been confirmed by the user. Android/Termux remains unqualified until a physical device completes enrollment, approval, heartbeat and metrics verification.

## Milestone 0 — Dashboard prototype
- [x] Responsive dashboard shell and navigation
- [x] Supabase email/password sign-in UI
- [x] Session refresh and sign-out flow using Supabase Auth
- [x] Remove hardcoded sample inventory from the active dashboard
- [x] Empty, loading, and API error states
- [x] Tenant selector and server-side role-scoped data
- [x] 15-second dashboard refresh and manual refresh
- [ ] Browser-based visual QA across target devices

## Milestone 1 — Control-plane foundation
- [x] Versioned API contract and control-plane architecture documented
- [x] PostgreSQL schema and initial RLS migration
- [x] PostgreSQL runtime migration/RLS integration checks in GitHub Actions
- [x] OIDC RS256 verifier retained as optional compatibility fallback
- [x] Supabase Auth token validation delegated to the configured Auth server
- [x] Database-backed identity resolution using issuer + subject
- [x] Transaction-local user context for pooled PostgreSQL connections
- [x] Tenant membership and Owner/Admin/Operator/Viewer RBAC
- [x] Protected APIs for current user, tenant listing, nodes, applications, deployments and jobs
- [x] Audit events for application, deployment and membership creation
- [x] API, auth and RBAC automated tests
- [x] GitHub Actions PostgreSQL integration workflow passed for the Supabase Auth/live dashboard implementation (run #92)
- [x] Configure Supabase Auth environment variables in Vercel (user confirmed)
- [x] Provision the first owner identity in the user's Supabase project (user confirmed)
- [x] Verify production login (user confirmed)
- [ ] Verify live dashboard data using a real enrolled node
- [ ] Production hardening: distributed rate limits, monitoring, secrets management and security review

## Independent control-plane deployment foundation
- [x] Vercel Node.js Function adapter and health endpoint
- [x] Explicit versioned API handler for `/api/v1/auth/me` plus a tenant-ID-scoped nested catch-all; tenant collection uses the versioned API adapter
- [x] Verify authenticated dashboard login in production (user confirmed)
- [x] Bounded serverless PostgreSQL pool
- [x] Supabase least-privilege runtime-role SQL
- [x] Vercel/Supabase deployment documentation
- [x] User confirmed deployed `/api/health` endpoint is working
- [x] Verify live authenticated dashboard login (user confirmed)
- [ ] Verify live node data from a physical device

## Milestone 2 — Node enrollment and agent
- [x] One-time, high-entropy enrollment tokens with configurable expiry
- [x] SHA-256-only token and node credential storage
- [x] Pending node registration and authenticated heartbeat
- [x] Offline status after missed heartbeat intervals
- [x] Strict typed diagnostic allowlist (`probe`, `collect_metrics`)
- [x] Tenant-scoped jobs with idempotency, leases, retries and guarded acknowledgements
- [x] Linux x86_64/aarch64 diagnostic node agent
- [x] Android/Termux environment detection and optional battery/thermal metric collection added
- [x] Unit coverage added for Android/Termux identity detection
- [ ] Verify GitHub Actions CI for latest Android/Termux and node-approval commits
- [x] Add tenant-scoped Owner/Admin node approval and rejection API
- [x] Add dashboard Approve/Reject controls for pending nodes
- [x] Rejection revokes active credentials and writes audit events
- [x] Approval sets recently heartbeating nodes online; stale nodes remain offline
- [x] Add API tests for approval, rejection, authorization and audit events
- [ ] Qualify Android/Termux on the user's physical phone
- [ ] Verify real heartbeat and resource metrics appear in dashboard
- [ ] Qualify Debian 12 and physical ARM64 Linux devices before production support

## Milestone 3 — Scheduler and deployment lifecycle
- [ ] Resource admission and placement policy
- [ ] Deployment revisions, health gates, rollback and event stream
- [ ] Per-node workload isolation and quotas

## Milestone 4 — Networking and operations
- [ ] Domain routing, TLS, service discovery and ingress
- [ ] Logs, metrics, alerts, backups and recovery drills
- [ ] Upgrade strategy and credential rotation

## Release gates
No production claim until automated tests, threat model, restore test, failure testing and documented support matrix pass. Android/Termux nodes remain best-effort until qualified.

# Delivery roadmap and implementation checklist

**Current stage:** Phase 1 — completing the control-plane dashboard and session/API reliability before scheduler and workload execution. Both Android/Termux devices have enrolled and connected (user-confirmed). Latest code changes are in `main`; production deployment and manual end-to-end QA must be verified before marking this phase complete.

## Milestone 0 — Dashboard prototype
- [x] Responsive dashboard shell and navigation
- [x] Supabase email/password sign-in UI
- [x] Session refresh and sign-out flow using Supabase Auth
- [x] Proactive token refresh before expiry and one-time retry after stale-token 401
- [x] Preserve refresh tokens through transient API/Auth network failures
- [x] Bounded short-lived Supabase token-verification cache for frequent polling
- [x] Remove hardcoded sample inventory from the active dashboard
- [x] Empty, loading, and API error states
- [x] Tenant selector and server-side role-scoped data
- [x] Three-second dashboard refresh and manual refresh through one combined snapshot
- [x] Combined snapshot includes nodes, applications, deployments, jobs and workspace members
- [x] Application creation UI connected to protected API
- [x] Deployment request UI connected to protected API (record creation only; no workload runtime)
- [x] Workspace member listing and role assignment UI
- [x] Operational overview panels for recent jobs and application inventory
- [x] Settings page showing session refresh, access-token expiry, API limit and runtime readiness
- [x] Bounded retry backoff after API/network failures, with manual refresh override
- [x] Diagnostic job form with explicit node selection
- [ ] Verify production deployment contains the latest `main` commit
- [ ] Verify Supabase session restoration after browser refresh on the user's device
- [ ] Measure production API latency and tune refresh/backoff behavior
- [ ] Manual visual and functional QA on Android/mobile and desktop
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
- [x] Verify live dashboard node status using a real enrolled Android node (online heartbeat confirmed by user)
- [ ] Verify resource metric values are rendered correctly in the dashboard
- [x] Vercel edge API rate limit: 600 requests per 60 seconds per source IP on `/api/v1/`
- [ ] Per-user application-level rate limits and dedicated login abuse monitoring
- [ ] Monitoring, secrets management and security review
- [ ] Confirm Supabase Auth JWT/session policy; client-side refresh cannot extend the configured JWT lifetime

## Independent control-plane deployment foundation
- [x] Vercel Node.js Function adapter and health endpoint
- [x] Explicit versioned API handler for `/api/v1/auth/me` plus a tenant-ID-scoped nested catch-all; tenant collection uses the versioned API adapter
- [x] Verify authenticated dashboard login in production (user confirmed)
- [x] Bounded serverless PostgreSQL pool
- [x] Supabase least-privilege runtime-role SQL
- [x] Vercel/Supabase deployment documentation
- [x] User confirmed deployed `/api/health` endpoint is working
- [x] Verify live authenticated dashboard login (user confirmed)
- [x] Verify physical Android node enrollment, approval and online heartbeat
- [ ] Verify end-to-end diagnostic job polling, claim and acknowledgement on the physical node

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
- [x] Verify GitHub Actions CI for latest Android/Termux and node-approval commits (run #122)
- [x] Add tenant-scoped Owner/Admin node approval and rejection API
- [x] Add dashboard Approve/Reject controls for pending nodes
- [x] Rejection revokes active credentials and writes audit events
- [x] Approval sets recently heartbeating nodes online; stale nodes remain offline
- [x] Add API tests for approval, rejection, authorization and audit events
- [x] Add Owner/Admin dashboard action to create short-lived one-time node enrollment tokens
- [x] Enroll and approve Android/Termux node on the user's physical phone; heartbeat accepted and node online
- [ ] Verify `probe` and `collect_metrics` jobs complete end-to-end on the physical node
- [ ] Verify real resource metric values appear in the dashboard
- [ ] Verify stop → offline and restart → online transitions
- [ ] Qualify Debian 12 and physical ARM64 Linux devices before production support

## Milestone 3 — Scheduler and deployment lifecycle
- [x] Pool-aware automatic job placement across approved, recently healthy nodes
- [x] Least-outstanding-jobs placement with oldest-assignment tie-break
- [x] Atomic node row locks with `SKIP LOCKED` to distribute concurrent submissions
- [x] Tenant-wide idempotency serialization so retries retain the original node assignment
- [ ] Load-aware capacity weights and fairness qualification under concurrent physical-node load
- [ ] End-to-end multi-node job claim/ack test on both Android devices
- [ ] Resource admission and placement policy
- [ ] Deployment revisions, health gates, rollback and event stream
- [ ] Per-node workload isolation and quotas

## Milestone 4 — Networking and operations
- [ ] Domain routing, TLS, service discovery and ingress
- [ ] Logs, metrics, alerts, backups and recovery drills
- [ ] Upgrade strategy and credential rotation

## Release gates
No production claim until automated tests, threat model, restore test, failure testing and documented support matrix pass. Android/Termux nodes remain best-effort until qualified.

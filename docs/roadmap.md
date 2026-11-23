# Delivery roadmap and implementation checklist

**Current stage:** Phase 3 — resource admission, transactional deployment-job orchestration, typed deploy/stop/restart lifecycle, rootless Podman execution, Cosign verification, HTTP health gates, automatic rollback orchestration and node-local endpoint registration are implemented in code and CI. Customer-facing hosting remains gated on trusted-key provisioning, reverse-proxy ingress/TLS, persistent volumes, continuous drift reconciliation and physical Linux-node qualification. Both Android/Termux devices have enrolled and connected (user-confirmed); they remain diagnostics/scheduler test nodes, not production workload hosts. Production migrations/deployment and manual end-to-end QA remain release gates.

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
- [x] Agent reports total, used and available RAM; agent-filesystem total/used/available; CPU core count, usage and optional frequency
- [x] Android shared internal storage total/used/available reported separately when Termux storage permission is granted
- [x] Heartbeat API validates expanded telemetry allowlist, payload bounds and capacity consistency; admission uses available RAM directly
- [x] Dashboard node details expose the expanded hardware resource metrics
- [ ] Verify all reported values against Android Settings and Termux on both physical devices
- [x] Unit coverage added for Android/Termux identity detection
- [x] Verify GitHub Actions CI for latest Android/Termux and node-approval commits (run #122)
- [x] Verify expanded hardware telemetry implementation in GitHub Actions (run #225 passed)
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
- [x] Resource requests and bounded CPU/memory/disk admission policy (migration/API/agent telemetry implemented; PostgreSQL + application CI passed in run #217)
- [x] Capacity reservations for active deployment revisions
- [x] Owner/Admin application desired-state API for running, stopped and suspended values, with tenant-scoped row locking and audit events
- [x] Operator+ queued/scheduled deployment cancellation with safe terminal status and audit event; active workload stop fails closed until runtime support exists
- [x] Dashboard controls for application desired state and queued deployment cancellation
- [x] Application stop/suspend locks the application and its deployment revisions in a consistent order
- [x] Stop/suspend cancels queued and scheduled revisions in the same transaction
- [x] Stop/suspend fails closed with HTTP 409 when a deployment is already deploying or healthy
- [x] Audit metadata records the requested state and number of cancelled revisions
- [x] Dashboard reports how many queued deployments were cancelled by an application state change
- [x] Lifecycle reconciliation API tests passed in GitHub Actions run #237
- [x] API tests for state transitions, authorization and audit events (CI run #229 passed; dashboard CI run #230 passed)
- [x] Health endpoint inspects existing PostgreSQL catalog metadata to report whether required schema and migration 007 are present, without exposing connection details
- [x] Health endpoint automated tests (PostgreSQL integration CI run #232 passed)
- [x] Fresh-heartbeat requirement and locked node selection; stale/unknown capacity fails closed
- [x] Linux/Termux agent reports logical CPU count in heartbeats for CPU admission
- [x] PostgreSQL integration verifies capacity reservations prevent sequential overcommit
- [ ] Apply migrations 007–012 to production DB and deploy the verified `main` build
- [x] Linux enrollment detects rootless Podman with a bounded fixed-argument probe; requires cgroup v2; never executes downloaded code
- [x] Termux explicitly skips container runtime probing and remains ineligible for container workloads
- [x] Runtime capability tests cover Podman missing/malformed, rootless, cgroup v1/v2 and Termux fail-closed behavior
- [x] Refresh and persist runtime capabilities on every authenticated node heartbeat (migration 008; API, agent and health checks updated)
- [x] Require Cosign signature verification against a node-local trusted public key before any OCI image pull; unsigned/invalid signatures fail closed
- [x] Advertise Cosign binary and trusted-key readiness in node heartbeats; deployment placement excludes nodes without both Podman and Cosign qualification
- [ ] Securely provision and rotate the trusted Cosign public key on every eligible production node
- [x] Implement rootless Podman workload adapter with immutable digest validation, rootless/cgroup-v2 gate, CPU/memory/PID limits, read-only rootfs, dropped capabilities, no-new-privileges and loopback-only port publication (CI runs #267–272 passed)
- [x] Agent dispatch for typed deploy/stop/restart jobs; rejects malformed payloads and never accepts arbitrary shell commands (CI runs #271–272 passed)
- [x] Workload jobs are terminally rejected on unqualified nodes instead of retrying forever (CI run #277 passed)
- [x] Connect authorized running deployment requests to immutable OCI image digest + TCP port validation and atomically queue a typed deploy job on the admitted node (migration 009)
- [x] Reconcile deployment status from node job acknowledgements: accepted/running/succeeded remains deploying pending health; terminal failure/rejection marks failed
- [x] Cancel queued deploy jobs when their deployment revision is cancelled
- [x] Dashboard collects immutable image digest and container port; generic job API remains diagnostic-only
- [x] Authenticated deployment state API queues stop jobs for active revisions and restart jobs for stopped revisions (migration 011)
- [x] Node agent confirms stop state and performs an HTTP health check after restart before the control plane reports stopped/healthy
- [x] Database reconciles stopping, stopped, restarting, healthy and failed deployment states from typed node job results
- [x] Application stop/suspend cancels queued revisions and queues stop jobs for active revisions atomically
- [x] Dashboard exposes stop/restart controls and verified health timestamps
- [x] API, agent and PostgreSQL integration tests cover deployment stop/restart lifecycle
- [x] API, health and PostgreSQL integration tests added for deployment job orchestration (CI run #301 passed)
- [x] Reconcile healthy running and interrupted stopping revisions when an approved node agent restarts; preserve manifests, avoid duplicate active jobs and reject stale nodes (migration 012)
- [x] Add configurable HTTP health-check path and timeout to deployment requests (migration 010)
- [x] Node agent polls loopback-mapped application endpoint and requires HTTP 2xx before reporting `workload_healthy`
- [x] Unhealthy containers are best-effort stopped/removed; failed jobs use bounded retry policy and terminal failures mark deployments failed
- [x] Database marks a deployment healthy only when the successful job attempt contains the explicit `workload_healthy` result code and records `health_checked_at`
- [x] Dashboard/API expose health-check configuration and verification timestamp
- [x] API, agent, health and PostgreSQL integration tests added for health gates
- [x] On terminal deploy failure, queue a typed restart of the previous health-verified revision on its fresh approved node (migration 013)
- [x] Preserve the prior revision's container ID, port and health-check policy; mark the failed revision rolled_back only after the restored revision passes its own HTTP health check
- [x] Avoid duplicate deployment rows/resource reservations; prevent recursive rollback and test no-previous-revision and rollback-failure cases
- [x] Return Podman's dynamically assigned loopback port and deterministic container identity in a bounded node acknowledgement payload
- [x] Persist only verified deployment-local port metadata from the active node lease; bind container identity to the deployment UUID and clear the port after confirmed stop (migration 014)
- [x] Add PostgreSQL tests for endpoint registration, forged container identity rejection and stop cleanup
- [ ] Verify automatic rollback on a qualified physical Linux node; public traffic switching remains blocked on reverse-proxy ingress/TLS
- [x] Define secure multi-node ingress architecture: public gateway, node-initiated authenticated reverse tunnels, strict tenant/deployment route binding and fail-closed lifecycle (design decision only; no public ingress enabled)
- [x] Add tenant-scoped domain claim and DNS challenge schema with canonical hostname constraints, global active-hostname uniqueness, one-live-challenge enforcement, one-hour expiry bounds and tenant RLS (migration 015)
- [x] Add atomic one-time challenge consumption, verified-state transition and append-only audit event function; PostgreSQL integration covers cross-tenant isolation, duplicate claims, malformed DNS names, mismatched records, wrong/expired/replayed tokens
- [ ] Implement API-side DNS TXT resolution, secure token generation/return-once flow and domain claim endpoints
- [ ] Implement route registry derived only from healthy, fresh deployment endpoints
- [ ] Implement per-node outbound mTLS tunnel and restricted loopback-only forwarder
- [ ] Implement gateway host routing, route versioning, request limits and fail-closed synchronization
- [ ] Implement TLS issuance, renewal, key rotation and expiry monitoring after domain verification
- [ ] Add ingress security/failure tests and qualify supported Debian 12 Linux nodes before customer traffic
- [x] Pass reserved disk bytes through deploy and recovery jobs; enforce Podman overlay writable-layer quota and require operator-qualified overlay storage before placement
- [x] Read Podman GraphRoot free space and perform disk admission against the actual container-storage filesystem
- [ ] Implement persistent application volumes, storage lifecycle and backup/restore
- [ ] Physical-node capacity qualification and real workload execution
- [ ] Deployment revisions, health gates, rollback and event stream
- [x] Per-container ephemeral writable-layer disk quota (Podman overlay size limit; operator qualification required)
- [ ] Persistent per-application volumes and backup/restore

## Milestone 4 — Networking and operations
- [ ] Domain routing, TLS, service discovery and ingress
- [ ] Logs, metrics, alerts, backups and recovery drills
- [ ] Upgrade strategy and credential rotation

## Release gates
No production claim until automated tests, threat model, restore test, failure testing and documented support matrix pass. Android/Termux nodes remain best-effort until qualified.

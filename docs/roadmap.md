# Delivery roadmap

## Milestone 0 — Dashboard prototype (current)
- [x] Responsive dashboard shell and navigation
- [x] Simulated node and application inventory
- [x] Sample node registration interaction
- [x] Local static server and health endpoint
- [ ] Browser-based visual QA across target devices

## Milestone 1 — Control-plane foundation
- Define API contracts and versioning
- Add authentication, RBAC, tenant model and audit events
- Add persistent database schema and migrations
- Add integration and security tests

## Milestone 2 — Node agent
- Define supported OS/runtime matrix
- Build outbound authenticated enrollment and heartbeat
- Add node capability and resource reporting
- Add safe command allowlist and job reconciliation

## Milestone 3 — Scheduler and deployment lifecycle
- Resource admission and placement policy
- Deployment revisions, health gates, rollback and event stream
- Per-node workload isolation and quotas

## Milestone 4 — Networking and operations
- Domain routing, TLS, service discovery and ingress
- Logs, metrics, alerts, backups and recovery drills
- Upgrade strategy and credential rotation

## Release gates
No production claim until automated tests, threat model, restore test, failure testing and documented support matrix pass. Android/Termux nodes must be explicitly labeled best-effort.

# Cloudexify multi-device hosting architecture

## Core model
Cloudexify is a distributed workload platform. Each device remains an independent compute node; CPU and RAM are not transparently combined into one machine. A scheduler places each workload on one eligible node based on declared requirements and node capacity.

## Logical planes
1. **Control plane** — API, identity, tenancy, desired state, policy, audit trail and orchestration.
2. **Node agent** — outbound authenticated connection, heartbeat, capability report, workload lifecycle and telemetry.
3. **Scheduler** — admission control, placement constraints, resource reservations, anti-affinity and retry policy.
4. **Workload runtime** — isolated process/container runtime appropriate to the host OS and available privileges.
5. **Ingress and service networking** — stable application routes, TLS termination, health checks and controlled node connectivity.
6. **Data plane services** — persistent volumes, backups, secrets and managed database integrations.
7. **Observability** — node/app health, logs, metrics, events and deployment history.

## Enrollment and trust
Agents should initiate outbound TLS connections to the control plane. Do not expose unauthenticated node-control ports to the public internet. Use unique per-node credentials, short-lived enrollment tokens, credential rotation/revocation, signed or mutually authenticated sessions, role-based access control and auditable actions. Never embed a fleet-wide secret in the agent binary or repository.

## Scheduling and reliability
A placement decision must account for CPU, memory, disk, architecture, OS/runtime capability, network reachability and user constraints. Reserve resources before dispatch. Use idempotent jobs, bounded retries, health-gated releases and rollback to the last known-good version. Persist desired state centrally; agents reconcile actual state toward it.

## Android and Linux feasibility
- Android with Termux can run selected user-space workloads, but Android may suspend or kill background processes; battery, thermal, storage and network changes constrain reliability.
- Ubuntu on a supported computer or server is a stronger general-purpose node target.
- Ubuntu in a proot environment on Android is not a full Linux kernel or virtual machine. Kernel-dependent container runtimes and systemd assumptions may not work.
- A phone cluster is suitable for experiments and low-risk services, not an SLA-backed production fleet without careful operational controls.

## Ingress direction
The accepted multi-node ingress design is documented in [Ingress architecture decision](ingress-architecture.md). Public traffic terminates at a gateway and reaches qualified Linux nodes through node-initiated authenticated reverse tunnels. Container ports remain loopback-only. This is an architecture decision, not an implemented ingress feature.

## Current implementation boundary
The repository has a functioning control-plane API/dashboard, PostgreSQL-backed tenant and node management, typed workload orchestration, a rootless Podman runtime adapter, health-gated deployment lifecycle, rollback orchestration and node-local endpoint registration. Public ingress, domain verification, TLS automation, persistent volumes and physical Linux-node qualification remain incomplete. Android/Termux devices are diagnostics/scheduler test nodes, not production workload hosts.

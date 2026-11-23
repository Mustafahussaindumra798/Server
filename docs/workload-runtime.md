# Workload runtime adapter

## Scope

The first runtime adapter uses rootless Podman on qualified Linux nodes only. Android/Termux nodes are not eligible. The adapter is deliberately not advertised as a generally available deployment runtime yet.

## Deployment request and control-plane orchestration

The authenticated deployment API now requires an immutable OCI digest and a TCP container port for running revisions. It inserts the deployment revision and its typed `deploy` job in the same tenant-scoped database transaction. Generic user-created jobs remain diagnostic-only. Migration 009 adds artifact metadata and database triggers that move deployment revisions to `deploying` when the node accepts/starts the job, to `failed` after terminal failure/rejection, and cancel queued deploy jobs when a revision is cancelled.

A successful container-start acknowledgement deliberately leaves the revision in `deploying`: the application has not passed a health check and must not be shown as `healthy`.

## Deployment payload

The adapter accepts only these fields:

- `deployment_id`: UUID
- `image`: fully qualified OCI image reference pinned to a SHA-256 digest (`@sha256:<64 lowercase hex>`)
- `container_port`: TCP port exposed by the image
- `resources.cpu_millicores`: 50–64000
- `resources.memory_bytes`: 16 MiB–1 TiB

Unknown fields, tags, mutable image references, arbitrary commands, environment injection, host mounts and privileged settings are rejected. A valid digest is not sufficient by itself: the image must also pass Cosign verification against the node's locally provisioned trust key.

## Container isolation

The adapter verifies image signatures with Cosign, then invokes Podman with an argument array (never a shell) and enforces:

- Rootless Podman and cgroup v2 qualification before every lifecycle operation
- Cosign signature verification with the node administrator's trusted public key at `/etc/cloudexify/trust.pub` before pulling an image
- Deployment placement requires fresh heartbeat capability evidence for Podman, rootless cgroup v2 and the configured Cosign trust key; Android/Termux and unqualified Linux nodes are excluded
- A deterministic container name and Cloudexify ownership/deployment labels
- A dedicated rootless `slirp4netns` network
- Inbound TCP published only on node loopback with a dynamically assigned host port
- CPU and memory limits plus a 128-process limit
- Read-only root filesystem and a bounded, no-exec temporary filesystem
- All Linux capabilities dropped, no-new-privileges, and a non-root container UID
- No host filesystem mounts or host networking

## Lifecycle semantics

- Deploy pulls the immutable image, creates the container, and verifies Podman's running state.
- Stop checks the resulting state and is idempotent for an absent or stopped container.
- Restart requires an existing container and verifies that it is running afterward.
- A workload job received by a node without rootless Podman/cgroup-v2 qualification is terminally rejected rather than retried indefinitely.
- A process running is not equivalent to an application passing its health check. Results explicitly state that health has not been verified.

## Release blockers before customer workloads

This adapter is a tested execution primitive, not yet a complete public deployment path. Do not set `workload_execution: true` or mark a deployment `healthy` until all of the following are implemented and tested:

1. Control-plane job creation/authorization and deployment-to-job state transitions.
2. Durable runtime reconciliation after node restart and expired job leases.
3. Application health checks and failure/rollback policy.
4. Reverse-proxy ingress, TLS, host routing and safe port lifecycle.
5. Per-container disk quota or a documented enforced storage boundary.
6. Structured workload logs, metrics, cleanup and upgrade/recovery procedures.
7. Provision and rotate the Cosign trust public key on every eligible node through a trusted node-administration process.
8. Debian 12 x86_64 and ARM64 qualification on real hosts.

The currently implemented adapter binds published ports to loopback only. It does not make applications publicly reachable.

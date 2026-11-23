# Linux Node Agent Runtime

**Version:** 0.1.0  
**Scope:** Linux x86_64 and aarch64 on Ubuntu 22.04/24.04 and Debian 12.  
**Status:** Initial diagnostic runtime; not a general-purpose workload runner.

## Security boundary

The agent makes outbound HTTPS requests only. It does not listen on a port, invoke a shell, execute a downloaded binary, evaluate job-provided code, or install a container runtime. The only job handlers are:

- `probe`: request the configured control plane's local `/api/health` endpoint and report reachability.
- `collect_metrics`: collect a bounded Linux resource snapshot from `/proc`, `os`, and filesystem statistics.

Unknown job types and non-empty job payloads are rejected. These handlers are diagnostics, not application deployment or compute workload execution.

## Requirements

- Linux x86_64 or aarch64.
- Node.js 22 LTS or newer supported LTS.
- Outbound TCP 443 to the Cloudexify control-plane URL.
- A node enrollment token issued by an authorized tenant Owner/Admin.
- The node must be approved by an administrator before it can receive jobs.

## Enroll

Run from the repository root. The token is one-time and the agent stores the returned node credential locally; do not paste it into logs, shell history, tickets, or source control.

```bash
export CLOUDEXIFY_CONTROL_PLANE_URL="https://your-control-plane.example"
export CLOUDEXIFY_NODE_NAME="$(hostname)"
read -rsp "One-time enrollment token: " CLOUDEXIFY_ENROLLMENT_TOKEN
printf '\n'
export CLOUDEXIFY_ENROLLMENT_TOKEN
npm run agent -- enroll
unset CLOUDEXIFY_ENROLLMENT_TOKEN
```

The default credential directory is `~/.local/share/cloudexify-agent`. Set `CLOUDEXIFY_AGENT_STATE_DIR` to select another directory. The directory is restricted to mode 0700 and `node.json` is written atomically with mode 0600. Symlinked state paths/files and credentials with group/world permissions are rejected.

Enrollment creates a **pending** node. An administrator must approve it in the control plane before it can receive jobs. Enrollment does not bypass approval.

## Run in foreground

```bash
npm run agent -- run
```

The agent sends a heartbeat immediately and then every 60 seconds. It polls for one job every 10 seconds. Intervals can be changed within bounded limits:

- `CLOUDEXIFY_HEARTBEAT_SECONDS`: 15–300, default 60.
- `CLOUDEXIFY_POLL_SECONDS`: 5–120, default 10.

SIGINT and SIGTERM stop the loop cleanly. Transient network failures are logged without credentials and retried. Invalid, expired or revoked credentials stop the agent rather than continuing to poll.

## systemd service

The repository includes [cloudexify-node-agent.service](../deploy/systemd/cloudexify-node-agent.service). The example assumes the project is installed at `/opt/cloudexify-agent`, a dedicated `cloudexify-node` user exists, and the state directory is `/var/lib/cloudexify-node`.

After installing the project and enrolling the node as the service user:

```bash
sudo install -D -m 0644 deploy/systemd/cloudexify-node-agent.service /etc/systemd/system/cloudexify-node-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now cloudexify-node-agent
sudo systemctl status cloudexify-node-agent
```

Set the control-plane URL in `/etc/cloudexify/node-agent.env` if desired. Do not put the one-time enrollment token or node credential in that file. The unit uses a dedicated unprivileged account, a private state directory, read-only system paths, and systemd sandboxing. Validate the service against the target distribution before production use.

## Runtime capability detection

At enrollment, the agent performs a bounded, non-mutating Podman probe on Linux only. It invokes the fixed executable `podman info --format json` without a shell, with a 3-second timeout and a 64 KiB output cap. It records the Podman version only when returned by the local runtime.

A node advertises `container_runtime: podman-rootless` only when all of these checks pass:

Workload placement additionally requires the Podman `overlay` storage driver, readable free space from Podman's actual `GraphRoot` filesystem, and an explicit operator attestation: set `CLOUDEXIFY_STORAGE_QUOTA_READY=true` only after the backing filesystem has project-quota support configured and tested. This is an administrative assertion, not an automatic filesystem proof; Podman applies the per-container `--storage-opt=size=...` limit at creation and fails the deployment if the backing store rejects it.

- Podman responds with valid JSON.
- Podman reports rootless mode.
- Podman reports cgroup version v2.
- `/sys/fs/cgroup/cgroup.controllers` is readable and non-empty.

Missing binaries, malformed output, timeouts, rootful Podman, or missing cgroup v2 fail closed. Termux never probes or advertises a container runtime. This is capability discovery only: `workload_execution` remains `false`. No image is pulled, no container is created, and no application code is executed.

## Observability and limitations

Structured logs include timestamps, node ID, job ID, and bounded result codes; they never intentionally include the node credential or lease token. Metrics that cannot be read are omitted rather than represented as zero. The CPU percentage is sampled over a short interval; disk and memory values are point-in-time estimates.

The agent now requests an authenticated runtime reconciliation once after its first successful heartbeat on every process start. The control plane requeues only healthy running revisions and interrupted stopping revisions that have no active job, preserves the saved immutable deployment manifest, and refuses stale/unapproved nodes. This recovers desired state after agent/host restart; it is not continuous drift detection. Credential rotation, automatic installation/upgrades, Android/Termux workloads, Windows/macOS support, complete workload isolation, Docker/Podman management and public ingress remain out of scope. The systemd unit is a reviewed template, not an installer or platform certification. Keep the node in a non-production environment until the release qualification checklist in [the support matrix](node-runtime-support.md) has passed.

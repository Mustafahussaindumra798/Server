# Cloudexify Node OS and Runtime Support Matrix

**Document status:** Initial support policy for the node-agent implementation.
**Policy version:** 1.0
**Last reviewed:** 2026-11-21

This matrix defines the intended support boundary. A platform listed as a target is not automatically implemented, tested, or production-certified. The agent must report capabilities it has actually detected; it must never infer support from an OS name alone.

## Support tiers

| Tier | Meaning | Workload suitability |
|---|---|---|
| Production target | First-class engineering and release target. Must pass the platform's installation, lifecycle, security, networking and upgrade tests before a production support claim. | Eligible for production workloads only after release gates pass. |
| Best-effort | Experimental environment with known OS/runtime restrictions and no uptime guarantee. | Development, testing and non-critical workloads only. |
| Planned | Design target; implementation and compatibility validation have not been completed. | Not eligible to enroll as a supported agent until a release explicitly enables it. |
| Unsupported | Not a supported deployment environment. | Do not install or advertise as a Cloudexify node. |

## Platform matrix

| Platform | CPU architectures | Tier | Agent runtime | Service lifecycle | Key constraints |
|---|---|---|---|---|---|
| Linux server (Ubuntu 22.04/24.04 LTS, Debian 12) | x86_64, aarch64 | **Production target** (release-gated) | Node.js 22 LTS or newer supported LTS; packaged agent should eventually bundle or pin its runtime | systemd service preferred; supervised foreground process also supported for development | First implementation target. Require outbound HTTPS. Docker is optional and must be separately detected; never required for node registration or control-plane connectivity. |
| Android 10+ with Termux (F-Droid/GitHub Termux distribution) | arm64-v8a / aarch64 | **Best-effort** | Termux userland with a supported Node.js LTS package | Foreground Termux session initially; optional Termux:Boot integration later, with explicit user setup | Android may suspend/kill processes; Doze, battery saver, thermal limits, storage permissions and network changes affect availability. No uptime guarantee. No assumed systemd, Docker daemon, root, kernel modules or privileged networking. |
| Windows 10/11 and supported Windows Server releases | x86_64; ARM64 only after validation | **Planned** | Node.js 22 LTS or newer supported LTS | Windows Service wrapper or supported service manager, not yet selected | Service installation, ACLs, firewall behavior, upgrades and credential storage require dedicated testing. |
| macOS 13+ | Apple silicon (arm64) and Intel (x86_64) only after validation | **Planned** | Node.js 22 LTS or newer supported LTS | launchd agent/daemon, not yet implemented | Keychain integration, signing/notarization, sleep behavior and launchd lifecycle require dedicated testing. |
| 32-bit Linux / Android | 32-bit ARM or x86 | **Unsupported** | None | None | No 32-bit build, test or security-maintenance commitment. |
| iOS / iPadOS | — | **Unsupported** | None | None | Background execution and app distribution constraints do not fit the initial always-available node-agent model. |
| ChromeOS, routers, NAS appliances, embedded/IoT distributions | Varies | **Unsupported unless separately qualified** | None | None | May be considered only after a specific OS, CPU, libc, storage and service-lifecycle qualification. |

## Baseline requirements for supported agent builds

- A 64-bit OS and CPU architecture explicitly listed for that release.
- Node.js 20 LTS or a newer supported LTS while the agent is developed as a Node.js application. The release must pin and test its exact runtime version.
- Outbound TCP 443 connectivity to the configured Cloudexify control-plane endpoint with valid TLS certificate verification.
- A writable, user-restricted data directory for the node credential and local state. Credential files must not be world-readable.
- A reliable system clock for diagnostics and TLS validation; server time remains authoritative for token expiry and request ordering.
- Enough free memory and disk for the agent itself. Workload capacity is a separate, dynamically probed capability and is not guaranteed by agent compatibility.
- No inbound public management port is required.

## Capability and workload rules

1. The agent reports platform, architecture, agent_version and only capabilities successfully probed on that device.
2. Missing or unavailable metrics are represented as unavailable/null, never fabricated as zero.
3. Runtime compatibility does not imply workload compatibility. For example, a Linux node without a usable container runtime may enroll and report health but must not advertise container execution.
4. Docker/Podman, cgroups, namespaces, systemd, GPU access, privileged networking and persistent storage are optional capabilities. Each needs an explicit probe and separate workload policy.
5. Android/Termux must default to low resource reservations and non-critical workloads. The control plane must display its best-effort tier.
6. A node must not receive a workload whose required isolation/runtime capabilities it has not reported and passed policy checks for.
7. Enrollment alone does not approve a node for workload execution. Approval and job authorization are separate lifecycle controls.

## Initial implementation order

1. **Linux x86_64 and aarch64:** implement and validate the first agent build on Ubuntu 22.04/24.04 LTS and Debian 12.
2. **Android arm64 / Termux:** implement a restricted best-effort profile after Linux agent lifecycle and credential handling are stable.
3. **Windows x86_64:** qualify service lifecycle, credential protection and upgrades before enabling the platform.
4. **macOS arm64/x86_64:** qualify launchd, signing and credential storage before enabling the platform.

## Release qualification checklist

A platform may be marked production-supported only when its CI/device test matrix covers:

- [ ] Clean install and upgrade from the previous supported agent version.
- [ ] Start, stop, restart and crash recovery using the platform service manager.
- [ ] Outbound TLS connection, proxy/network failure and reconnect with exponential backoff and jitter.
- [ ] Secure credential file permissions/storage, rotation and revocation behavior.
- [ ] Accurate OS, architecture, runtime and capability detection.
- [ ] Resource reporting under normal load and constrained memory/disk.
- [ ] Graceful shutdown and safe behavior when the control plane is unavailable.
- [ ] Uninstall behavior that removes service registration and local secrets according to documented policy.
- [ ] Platform-specific security review and supported-version policy.

**Current validation status:** Linux agent v0.1.0 implements enrollment, owner-only credential storage, heartbeat reporting, and the two allowlisted diagnostic handlers. GitHub Actions [Linux node agent run #3](https://github.com/danyalbut96-khan/Server/actions/runs/44977033343) passed all 48 tests on Ubuntu 22.04/24.04 with Node.js 20/22. Node.js 22+ is the recommended runtime; Node.js 20 was retained as a compatibility test only. No production certification, physical ARM64 device validation, automated installer/upgrader, or general workload execution is claimed.

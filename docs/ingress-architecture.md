# Ingress architecture decision

**Status:** Accepted as the implementation direction; no public ingress is enabled by this document.
**Scope:** Customer hostname routing for healthy deployments across independently networked nodes.

## Context

A healthy deployment currently reports a dynamically assigned Podman port published on the node loopback interface. The control plane stores that port as `deployments.runtime_local_port` together with `runtime_observed_at`. A loopback address is reachable only from the node itself. A central gateway cannot use it directly, and publishing the container port on a public interface would bypass the intended isolation boundary.

Nodes may be behind NAT, mobile networks or changing residential IP addresses. The control plane must not require inbound node firewall rules or assume that node addresses are stable.

## Decision

Use a **public ingress gateway plus node-initiated authenticated reverse tunnels**.

1. Customer DNS points to a Cloudexify-managed ingress gateway. The gateway terminates public TLS and performs strict hostname routing.
2. A qualified Linux node establishes an outbound, mutually authenticated, persistent tunnel to the gateway. The node agent (or a separately supervised tunnel sidecar) owns reconnect, credential rotation and bounded backoff.
3. The gateway forwards a request through the authenticated tunnel to the node-local proxy/endpoint. The node-side component may connect only to a loopback port registered by the control plane for the exact deployment assigned to that node.
4. Container ports remain bound to loopback. No customer traffic is sent directly to a node's public IP or exposed container port.
5. The control plane is authoritative for tenant ownership, verified domains, active deployment revision, target node, endpoint port and route state. The gateway consumes a narrowly scoped, authenticated route feed; it does not query arbitrary URLs or accept customer-supplied upstreams.

This avoids depending on inbound reachability to nodes and works across NAT. It also separates public TLS and hostname routing from workload execution.

## Route lifecycle

A route must be created or activated only when all of the following are true:

- The domain is normalized and syntactically valid; internationalized names are stored in a canonical ASCII/IDNA form.
- The domain is verified by a tenant-controlled DNS challenge before activation. Verification records are unpredictable, time-limited and scoped to one tenant/domain claim.
- The deployment belongs to the same tenant as the domain claim and is the selected active revision for its application.
- The deployment status is `healthy`, its node is approved and recently online, and its endpoint metadata is present and fresh.
- The target node has a healthy authenticated tunnel and is explicitly qualified for ingress.

Route states should be explicit and auditable (for example: pending verification, verified, pending certificate, active, draining, suspended, failed). Route changes must be idempotent and versioned. A route must be withdrawn on deployment stop, failed health, rollback transition, node revocation/offline expiry, domain verification loss or tenant suspension. A new revision becomes routable only after its health gate passes; rollback switches the route back only after the restored revision is healthy.

## Security requirements

- Use per-node, revocable credentials and mutual TLS for tunnel authentication. Never use a fleet-wide shared secret.
- Bind each tunnel identity to one node ID. Bind every route to a tenant, application, deployment and target node; reject cross-tenant or mismatched-node updates.
- The gateway accepts only control-plane-issued route records. It must not accept arbitrary upstream URLs, IP addresses, ports or Host-header overrides from clients.
- The node-side forwarder accepts only a deployment ID and a port authorized for that same node. It connects only to loopback and validates port range. It must not expose a general TCP proxy or shell.
- Reject unknown hosts, malformed/ambiguous hostnames, duplicate claims and unverified domains. Normalize hostnames before uniqueness checks to prevent case, trailing-dot and IDNA bypasses.
- Strip hop-by-hop headers, sanitize forwarded headers, preserve the original host only as validated routing metadata, and enforce request/header/body/time limits.
- Prevent HTTP request smuggling by using a single well-defined HTTP parser boundary and consistent framing rules between gateway and node-side proxy.
- Enforce per-tenant and per-domain request limits, connection limits and abuse controls. Do not trust client-supplied `X-Forwarded-*` headers.
- Keep private tunnel addresses, credentials, certificate private keys and upstream details out of browser responses and logs.
- Audit domain claim, verification, certificate, route activation, route switch, suspension and deletion events.

## TLS and certificate lifecycle

The ingress gateway is the public TLS termination point. Issue certificates only after domain ownership verification and DNS points to the supported ingress. Use ACME DNS-01 or HTTP-01 only where the challenge can be completed safely; never issue for an unverified claim. Store private keys in a dedicated secret store with restricted access, not in the application database or repository. Renew before expiry, monitor renewal failures, support key rotation and revoke certificates when a domain is released or ownership is lost. Unknown or invalid SNI/Host combinations must fail closed.

## Availability and consistency

- Tunnel disconnect: mark the node path unavailable and withdraw or fail routes closed after a bounded grace period; do not route to a stale endpoint.
- Node heartbeat loss or credential revocation: immediately invalidate its route authorization.
- Deployment stop/failure: withdraw the route; do not retain a stale port.
- Deployment replacement: health-check the new revision before switching; retain the previous route only while its deployment remains healthy and policy allows it.
- Gateway restart: reconstruct routes from the authoritative control plane; do not treat an in-memory cache as authoritative.
- Route feed delay or version gap: reject stale updates and reconcile from a full authoritative snapshot.
- Rollback: route to the restored revision only after its health check succeeds.
- If the tunnel, route registry, certificate or ownership state is uncertain, return an error rather than forwarding to an unverified upstream.

## Implementation sequence

1. Add tenant-scoped domain claims and verification challenge lifecycle with database constraints, RLS, audit events and integration tests.
2. Add route registry records tied by composite tenant/deployment/node relationships; derive eligible routes from healthy deployment state rather than accepting arbitrary upstreams.
3. Implement per-node outbound mTLS tunnel and a restricted loopback forwarder; qualify reconnect, revocation and node identity binding.
4. Implement gateway route synchronization, strict host matching, request limits, route versioning and fail-closed behavior.
5. Add certificate issuance, renewal, rotation and expiry monitoring after DNS/domain verification is operational.
6. Run security tests for cross-tenant routing, forged Host headers, SSRF, stale route replay, tunnel impersonation, node revocation, deployment stop, rollback and gateway restart.
7. Perform physical qualification on supported Debian 12 x86_64 and ARM64 Linux nodes before enabling customer traffic.

## Explicit non-goals and release gates

This decision does not implement a proxy, tunnel, DNS automation, domain verification, certificate management or customer ingress. It does not make Android/Termux nodes production hosts. Do not publish container ports on public interfaces. Do not advertise customer-facing hosting until the full sequence, threat review, failure tests and physical Linux qualification pass.

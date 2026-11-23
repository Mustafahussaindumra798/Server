# Ingress architecture decision

**Status:** Accepted. HTTPS hostname proxy and tunnel data plane are implemented behind an explicit opt-in; public ingress remains disabled by default and is not production-qualified.
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
5. The control plane is authoritative for tenant ownership, verified domains, healthy deployment, target node, endpoint port and route state. The gateway queries the route registry by normalized hostname and accepts only active, transport-qualified records; it never accepts customer-supplied upstream URLs or ports.

This avoids depending on inbound reachability to nodes and works across NAT. It also separates public TLS and hostname routing from workload execution.

## Route lifecycle

A route must be created or activated only when all of the following are true:

- The domain is normalized and syntactically valid; internationalized names are stored in a canonical ASCII/IDNA form.
- The domain is verified by a tenant-controlled DNS challenge before activation. Verification records are unpredictable, time-limited and scoped to one tenant/domain claim.
- The deployment belongs to the same tenant as the domain claim and is the selected active revision for its application.
- The deployment status is `healthy`, its node is approved and recently online, and its endpoint metadata is present and fresh.
- The target node has a healthy authenticated tunnel and is explicitly qualified for ingress.

Route states are explicit and auditable: `pending_transport`, `active` and `suspended` in the current registry; domain claims separately track verification. Node ingress admission is separately controlled by `nodes.ingress_draining`: setting it blocks new hostname lookups and signed grants without changing route status/version, while existing requests continue periodic eligibility revalidation and may finish. The gateway synchronizes this flag every three seconds, rejects new streams on draining nodes, and allows active streams to complete up to the bounded drain timeout. Route versions are signed into short-lived grants. Runtime loopback-port changes advance the route version (migration 019), and target-node changes withdraw the route pinned to the previous node. The gateway revalidates every active request approximately every 15 seconds against the exact route ID/version, tenant/domain/deployment eligibility, target node and loopback port, plus the live authenticated tunnel. Missing/ineligible rows, node disconnects or database revalidation errors terminate the existing request fail-closed. Route changes must be idempotent and versioned. A route must be withdrawn on deployment stop, failed health, rollback transition, node revocation/offline expiry, domain verification loss or tenant suspension. A new revision becomes routable only after its health gate passes; rollback switches the route back only after the restored revision is healthy.

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

## Route registry implementation boundary

Migration `016_deployment_domain_route_registry.sql` adds an internal `deployment_domain_routes` registry. A route intent is bound by composite tenant foreign keys to one verified domain claim, application, deployment and target node. Registration is restricted to tenant Owner/Admin and requires an active tenant, running application, healthy running deployment, a recently observed loopback endpoint, and an approved, online, recently heartbeating Linux node.

Migration `016_deployment_domain_route_registry.sql` initially created only pending route intents. Migration `018_activate_ingress_routes.sql` adds the guarded `active` state. Routes activate only when domain/deployment/node eligibility is intact and the node heartbeat explicitly advertises both `ingress_tunnel=true` and `loopback_forwarder=true`; loss of any prerequisite suspends the route. Migration `019_ingress_route_endpoint_version.sql` increments the active route version when its deployment loopback port changes, without persisting that port in the route registry. The registry still stores no upstream URL, public IP or local port. The gateway reads the runtime loopback port from the associated healthy deployment record and signs it into a short-lived grant. Route registration remains tenant Owner/Admin restricted and audited.

The database function `app_private.register_deployment_domain_route(domain_claim_id, deployment_id)` is the current internal registration interface. It is not a customer-facing route API and does not make DNS resolve or traffic flow.

## Operator-controlled node ingress drain

Tenant Owners and Admins can stop or resume ingress admission for an approved node:

`POST /api/v1/tenants/{tenant_id}/nodes/{node_id}/state`

Request body:

```json
{ "ingress_state": "draining" }
```

Use `"active"` to resume. The API validates tenant ownership, records an audit event, and only permits resume when the node is approved, online with a fresh heartbeat, Linux-based, and advertising both `ingress_tunnel` and `loopback_forwarder` capabilities. Draining blocks new hostname lookups and signed route grants without changing the route version; the gateway reconciles connected-node drain state every three seconds and allows existing streams to finish within the bounded drain timeout. The dashboard exposes these controls only to Owners/Admins and requires confirmation before draining.

## Implementation sequence

1. Add tenant-scoped domain claims and verification challenge lifecycle with database constraints, RLS, audit events and integration tests.
2. Add the fail-closed route-intent registry with tenant-bound domain/deployment/node relationships, eligibility checks, lifecycle withdrawal and PostgreSQL integration tests.
3. [x] Implement per-node outbound mTLS control transport, node identity binding, database-backed certificate revocation checks and bounded reconnect behavior.
4. [x] Implement signed Ed25519 route grants and restricted node-side loopback forwarding; reject arbitrary host/port values.
5. [x] Implement bounded gateway multiplexing, normalized hostname matching, HTTPS termination, HTTP reverse-proxy piping, request limits and per-stream backpressure controls.
6. [x] Add guarded route activation/suspension based on node transport capability flags and current deployment/domain/node eligibility.
7. [ ] Add automated certificate issuance, renewal, multi-certificate SNI, rotation and expiry monitoring after DNS/domain verification is operational.
8. [x] Add periodic in-flight route revalidation and fail-closed termination on route/version/node/endpoint changes.
9. [x] Add database-backed node ingress drain state, Owner/Admin API control, gateway synchronization, new-request rejection and in-flight request preservation. Multi-node placement/failover remains pending.
10. [ ] Run security/load/failure tests for cross-tenant routing, forged Host headers, SSRF, stale route replay, tunnel impersonation, node revocation, deployment stop, rollback and gateway restart.
11. [ ] Perform physical qualification on supported Debian 12 x86_64 and ARM64 Linux nodes before enabling customer traffic.

## mTLS transport implementation boundary

Migration `017_node_tunnel_certificates.sql` adds per-node certificate fingerprint records and a database authorization function. `src/agent/tunnel.mjs` provides an outbound TLS 1.3 client with exact node-UUID certificate CN validation, gateway hostname validation, private ALPN, bounded reconnect backoff and terminal handling for gateway authorization rejection. `src/ingress/mtls-tunnel.mjs` provides the separate gateway-side mTLS listener, node identity binding, database-backed certificate authorization and periodic revocation/heartbeat rechecks. `tunnel-gateway.mjs` runs this listener on an explicit private interface; wildcard binds are rejected. The protocol accepts bounded hello/welcome/ping/pong/error control frames plus route_open, route_opened, route_data, route_close, route_error, route_pause and route_resume frames.

The tunnel now carries bounded route frames in addition to control frames. The node verifies short-lived Ed25519 grants, opens only the signed 127.0.0.1 port, and enforces stream caps, idle timeout and gateway-driven pause/resume. The gateway multiplexes route streams and provides an opt-in HTTPS reverse proxy. The mTLS listener itself must remain private. Certificate issuance and rotation are operator-managed; the HTTPS listener is disabled unless explicitly enabled with a valid certificate and grant-signing key. The route-stream manager exposes node-level drain and resume operations. Migration `020_node_ingress_drain_state.sql` adds the operator-controlled `nodes.ingress_draining` flag; the Owner/Admin API toggles it, route lookup and grant authorization block new requests while it is true, and the gateway polls connected-node drain state every three seconds. Existing requests remain eligible during periodic revalidation because draining does not change route status or version. The gateway permits existing streams to finish, resumes admission when the flag is cleared, and force-detaches remaining streams after the bounded timeout. Multi-node placement/failover remains a separate release task.

## Explicit non-goals and release gates

The current code does not yet provide automated ACME issuance/renewal, multi-certificate SNI, multi-node scheduling/failover or physical Debian 12 qualification. Periodic in-flight route revalidation and database-backed node draining are implemented; multi-node placement/failover remains pending. Android/Termux nodes remain diagnostics-only. Do not publish container ports on public interfaces or enable the public HTTPS listener until migration 018 is applied to the correct Server database, TLS/firewall operations are provisioned, and threat, load, failure and physical-node release gates pass.

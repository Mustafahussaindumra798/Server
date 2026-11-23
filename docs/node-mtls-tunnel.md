# Node mTLS tunnel operations

**Status:** Authenticated outbound mTLS transport, signed loopback forwarding, gateway stream multiplexing and an opt-in HTTPS reverse proxy are implemented. Public ingress remains disabled unless explicitly configured with a valid certificate and active routes.

## Trust model

- Every node has its own TLS client certificate. The certificate subject Common Name (CN) must exactly equal that enrolled node's UUID.
- The node private key remains on the node. The control plane stores only the SHA-256 certificate fingerprint, serial number and validity window.
- The gateway presents a TLS server certificate and requests a client certificate. Both sides require TLS 1.3 and the private ALPN `cloudexify-node-tunnel/1`.
- The gateway maps the certificate fingerprint and CN node ID to `app_private.authorize_node_tunnel_certificate`. Authorization requires an unrevoked, currently valid certificate, an active tenant, an approved online Linux node and a fresh node heartbeat.
- The gateway rechecks authorization every 15 seconds. Revocation or node/tenant ineligibility closes the connection. New handshakes are denied immediately after the database state changes.
- The protocol uses newline-delimited JSON. Control frames are limited to 4 KiB; bounded route frames are limited to 36 KiB and carry at most 24 KiB of base64-decoded stream data. Only known heartbeat and route frame types are accepted; malformed or unknown frames close the tunnel.

## Certificate provisioning

Use an internal CA or managed PKI to issue a unique client certificate for each node. Put the enrolled node UUID in the certificate CN. Issue a separate gateway server certificate whose SAN matches the gateway DNS name. Do not reuse certificates or private keys across nodes.

On the node, install:
- Gateway CA certificate readable by the agent.
- Node client certificate readable by the agent.
- Node private key owned by the agent account with mode `0600`.

Example paths:
- `/etc/cloudexify/tunnel/gateway-ca.pem`
- `/etc/cloudexify/tunnel/node-client.pem`
- `/etc/cloudexify/tunnel/node-client-key.pem`

The node client private key must be owned by the agent account and mode `0600` or stricter. The gateway server private key must likewise be owned by the gateway service account and mode `0600` or stricter; the gateway refuses symlinked/non-regular TLS files. The mTLS tunnel listener itself must remain on a loopback/private/link-local interface.

Register the node certificate's lowercase, colon-free SHA-256 fingerprint, serial number and validity dates in `node_tunnel_certificates`, associated with the exact `node_id` and `tenant_id`. Certificate identity/validity fields are immutable after insertion, and revocation is one-way; registration and revocation write audit events. Provisioning is an operator-controlled database operation; never expose a public certificate-registration endpoint that accepts an arbitrary node ID or fingerprint. The database migration is `017_node_tunnel_certificates.sql`.

For certificate rotation, issue a new per-node certificate, register its fingerprint, install the new certificate/key pair, verify a successful tunnel connection, then revoke the old fingerprint. To revoke immediately, set `revoked_at` for the certificate record. Existing connections are rechecked and closed within the configured 15-second authorization interval (plus database/network latency).

## Start the gateway

The gateway is a separate process. It defaults to loopback and refuses wildcard bind addresses. Remote nodes require an explicitly configured private interface address protected by firewall rules; do not expose the tunnel listener to the public internet.

Required environment:
- `DATABASE_URL`
- `CLOUDEXIFY_TUNNEL_SERVER_KEY`
- `CLOUDEXIFY_TUNNEL_SERVER_CERT`
- `CLOUDEXIFY_TUNNEL_CLIENT_CA`
- `CLOUDEXIFY_TUNNEL_LISTEN_HOST` (explicit private interface IP; default `127.0.0.1`)
- `CLOUDEXIFY_TUNNEL_LISTEN_PORT` (default `9443`)

Run `npm run tunnel-gateway`. The database role must be able to execute `app_private.authorize_node_tunnel_certificate(text,uuid)`. Keep the gateway listener on a private network segment and restrict source access to the known node egress ranges where practical.

## Configure a Linux node agent

Set all four variables in the agent's protected service environment:
- `CLOUDEXIFY_TUNNEL_URL=https://private-gateway.example:9443`
- `CLOUDEXIFY_TUNNEL_CA=/etc/cloudexify/tunnel/gateway-ca.pem`
- `CLOUDEXIFY_TUNNEL_CERT=/etc/cloudexify/tunnel/node-client.pem`
- `CLOUDEXIFY_TUNNEL_KEY=/etc/cloudexify/tunnel/node-client-key.pem`

The agent validates certificate CN, validity and private-key file permissions before connecting. It validates the gateway certificate and hostname, requires TLS 1.3 and the expected ALPN, and reconnects with exponential backoff capped at 30 seconds. Partial configuration or Android/Termux use fails closed. Do not place private keys in the repository, node JSON state, logs or shell history.

## Signed route-grant authorization foundation

The control plane now exposes a node-authenticated route authorization endpoint:

`GET /api/v1/nodes/{node_id}/routes/{route_id}/grant`

The node must send its existing node credential as a Bearer token. The control plane checks that credential and re-reads the route against the current tenant, verified domain claim, running application, healthy deployment, fresh runtime-local endpoint, exact target node, approved Linux status and fresh heartbeat. It returns a 30-second Ed25519-signed grant containing the route ID/version, tenant, hostname, deployment, exact node ID and a loopback-only upstream port.

The signing key is supplied only to the control plane as `CLOUDEXIFY_ROUTE_GRANT_PRIVATE_KEY`. It must be an Ed25519 private key in PEM form. Never put this private key on a node or in the repository. Nodes will receive only the matching Ed25519 public key through protected agent configuration. The grant format and verifier enforce the exact node identity, short expiry, unique grant ID, route version and `127.0.0.1` upstream. A gateway-provided host or port is never accepted as an authorization source. The Linux agent accepts `CLOUDEXIFY_ROUTE_GRANT_PUBLIC_KEY` (Ed25519 public PEM) and verifies each `route_open` grant before opening a socket. It enforces one-time grant IDs, exact node binding, 32 concurrent streams, strict stream IDs, bounded base64 data frames, idle timeouts and loopback-only `net.connect`; the upstream port comes only from signed claims. The node emits `route_opened`, `route_data`, `route_close` and `route_error` frames. The gateway-side stream scheduler and reverse proxy are not yet implemented, so these frames are not currently driven by customer HTTP traffic.

The grant endpoint requires the protected signing key and an active, transport-qualified route. Migration `018_activate_ingress_routes.sql` activates routes only when the verified domain, healthy deployment and approved Linux node are eligible and the node advertises both ingress capability flags. The gateway-side stream scheduler, backpressure coordination, HTTPS reverse proxy and node-side loopback forwarder are implemented. Public ingress remains disabled by default and is not production-qualified.

## HTTPS hostname ingress and reverse proxy

The gateway includes an opt-in HTTPS listener. It terminates client TLS, normalizes the HTTP Host header, resolves only an active route in the tenant-scoped route registry, checks that the route's exact node has a live authenticated tunnel, obtains a short-lived Ed25519 grant, and proxies the HTTP request through a dedicated multiplexed tunnel stream to the signed loopback port. The node never accepts a gateway-supplied host or port. The gateway strips hop-by-hop headers, sets trusted X-Forwarded-* headers, enforces request/header/stream bounds and timeouts, and returns 404/421/502/503 errors fail-closed. During each active request it revalidates the exact route ID/version, tenant/domain/deployment eligibility, target node and loopback port approximately every 15 seconds. Route revocation, endpoint changes, node disconnects or database revalidation errors terminate existing traffic fail-closed. Migration `019_ingress_route_endpoint_version.sql` advances the route version when the deployment loopback port changes; target-node changes suspend the old node-pinned route.

A new migration, 018_activate_ingress_routes.sql, adds the guarded active route state. A route becomes active only when the domain, tenant, application, deployment endpoint and approved Linux node remain eligible and the node heartbeat advertises both ingress_tunnel=true and loopback_forwarder=true. Removing either capability, losing node eligibility, or making the deployment/domain unhealthy suspends the route. The gateway independently checks the live mTLS session before proxying. The existing route-grant authorization query now issues grants only for active, transport-qualified routes.

To enable the HTTPS listener on a qualified gateway, configure all of the following in its protected service environment:

- CLOUDEXIFY_PUBLIC_INGRESS_ENABLED=true
- CLOUDEXIFY_INGRESS_LISTEN_HOST=0.0.0.0 (or a specific public interface)
- CLOUDEXIFY_INGRESS_LISTEN_PORT=443
- CLOUDEXIFY_INGRESS_TLS_CERT=/etc/cloudexify/ingress/fullchain.pem
- CLOUDEXIFY_INGRESS_TLS_KEY=/etc/cloudexify/ingress/privkey.pem
- CLOUDEXIFY_ROUTE_GRANT_PRIVATE_KEY (Ed25519 private PEM; protected gateway secret)

The certificate must be currently valid and its SAN/wildcard coverage must match each hostname routed through this listener. The private key must be owned by the gateway service account and mode 0600 or stricter. The gateway currently loads one certificate/key pair at startup; multi-certificate SNI selection, automated ACME issuance/renewal, OCSP and certificate rotation are not yet implemented. Keep the mTLS tunnel port private and expose only the HTTPS listener through the intended firewall/load-balancer policy.

Nodes advertise the two ingress capability flags only when all mTLS tunnel settings and the route-grant public key are configured. The gateway still requires the node's mTLS session to be currently connected. The database route is pinned to its deployment's target node; this implementation does not yet perform multi-node failover or cross-node workload scheduling. If that node is disconnected or the route is not active, requests fail closed rather than selecting an unrelated node.

**Important:** This is an implementation milestone, not production authorization to receive customer traffic. Do not set the public-ingress flag or expose port 443 until migrations 018 and 019 have been reviewed and applied to the correct Server database, gateway TLS certificates and firewall are provisioned, the node is a qualified Debian/Linux workload host, and end-to-end security/load/failure tests have passed.

## Current limitations

- The HTTPS reverse proxy and node-side TCP forwarding are implemented, but public ingress is opt-in and must remain disabled until database migration, TLS, firewall and physical-node release gates are satisfied.
- Automated certificate issuance/renewal, multi-certificate SNI selection, multi-node failover, graceful route draining, production firewall qualification and physical Debian 12 workload qualification remain pending.
- Certificate issuance and rotation are operator-managed; automated PKI enrollment is not implemented.
- A gateway restart drops tunnels; node agents reconnect. No persistent gateway session state is required.
- Physical Debian 12 x86_64/ARM64 qualification and firewall review are still required.

Do not advertise public hosting or mark a route active until the restricted loopback forwarding protocol, route authorization, gateway request proxy, public TLS, abuse controls and failure tests have been implemented and qualified.

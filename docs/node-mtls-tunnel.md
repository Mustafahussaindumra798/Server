# Node mTLS tunnel operations

**Status:** Authenticated outbound tunnel transport implemented; no workload forwarding is enabled.

## Trust model

- Every node has its own TLS client certificate. The certificate subject Common Name (CN) must exactly equal that enrolled node's UUID.
- The node private key remains on the node. The control plane stores only the SHA-256 certificate fingerprint, serial number and validity window.
- The gateway presents a TLS server certificate and requests a client certificate. Both sides require TLS 1.3 and the private ALPN `cloudexify-node-tunnel/1`.
- The gateway maps the certificate fingerprint and CN node ID to `app_private.authorize_node_tunnel_certificate`. Authorization requires an unrevoked, currently valid certificate, an active tenant, an approved online Linux node and a fresh node heartbeat.
- The gateway rechecks authorization every 15 seconds. Revocation or node/tenant ineligibility closes the connection. New handshakes are denied immediately after the database state changes.
- The protocol is newline-delimited JSON control frames with a 4 KiB limit. Only `hello`, `welcome`, `ping`, `pong` and `error` are supported. Unknown frames are rejected. This transport does not carry HTTP requests, TCP streams or arbitrary forwarding instructions.

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

## Current limitations

- The tunnel is an authenticated control channel only. It does not forward HTTP or TCP traffic.
- No route grant protocol, per-deployment loopback connector, gateway public listener, public DNS routing or customer TLS termination is enabled.
- Certificate issuance and rotation are operator-managed; automated PKI enrollment is not implemented.
- A gateway restart drops tunnels; node agents reconnect. No persistent gateway session state is required.
- Physical Debian 12 x86_64/ARM64 qualification and firewall review are still required.

Do not advertise public hosting or mark a route active until the restricted loopback forwarding protocol, route authorization, gateway request proxy, public TLS, abuse controls and failure tests have been implemented and qualified.

# Cloudexify Server — Credential & Cryptographic Key Rotation Procedures

This guide defines the end-to-end procedures for rotating all credentials, API keys, and cryptographic keys utilized across the Cloudexify Server platform without service disruption.

---

## 1. Cryptographic Key Inventory

| Key / Credential | Type / Algorithm | Stored Location | Lifetime / Rotation Window | Zero-Downtime Method |
|---|---|---|---|---|
| **Node Credentials** | 256-bit high-entropy secret, SHA-256 hashed | `node_credentials` DB table & local node state file | 90 days | Dual-credential overlapping window |
| **Route Grant Signing Key** | Ed25519 private key | Environment variable (`CLOUDEXIFY_ROUTE_GRANT_PRIVATE_KEY`) | 180 days | 30s TTL clock-skew transition |
| **Node mTLS Tunnel Certificates** | TLS 1.3 client certificates (ECDSA P-256) | Gateway trust store & `node_tunnel_certificates` DB table | 365 days | Fingerprint pre-registration |
| **Supabase Anon / Service Role Keys** | JWT / HMAC-SHA256 | Vercel Environment Variables & GitHub Actions Secrets | Annual / On-Demand | Supabase dual-key rollout |
| **Domain TLS Certificates** | X.509 RSA 2048 / ECDSA P-256 | `domain_tls_certificates` DB table | 90 days (ACME) | Auto-renew at 30 days remaining |

---

## 2. Node Credential Rotation

Node credentials authenticate node heartbeats, job claiming, and loopback endpoint registration.

### Standard Zero-Downtime Rotation
1. **Generate New One-Time Enrollment Token:**
   Tenant Owner or Admin issues a short-lived enrollment token:
   ```http
   POST /api/v1/tenants/:tenantId/enrollment-tokens
   Authorization: Bearer <AdminToken>
   Content-Type: application/json

   { "expires_in_minutes": 30 }
   ```
2. **Re-enroll Node with New Credential:**
   Node agent issues:
   ```http
   POST /api/v1/nodes/enroll
   Content-Type: application/json

   {
     "enrollment_token": "<OneTimeToken>",
     "name": "edge-node-01",
     "platform": "linux",
     "architecture": "x86_64"
   }
   ```
3. **Approve and Confirm:**
   Owner approves the re-enrolled credential via `POST /api/v1/tenants/:tenantId/nodes/:nodeId/approve`.
4. **Revoke Old Credential:**
   Once heartbeats succeed under the new credential, revoke the previous credential:
   ```http
   POST /api/v1/tenants/:tenantId/nodes/:nodeId/credentials/:credentialId/revoke
   Authorization: Bearer <AdminToken>
   ```

### Emergency Revocation
If a node is physically compromised or lost:
```bash
# Immediately marks node revoked and terminates all active job leases
curl -X POST https://control-plane.cloudexify.com/api/v1/tenants/$TENANT_ID/nodes/$NODE_ID/reject \
  -H "Authorization: Bearer $OWNER_TOKEN"
```

---

## 3. Route Grant Signing Key Rotation (Ed25519)

The Ed25519 private key signs short-lived (30-second TTL) loopback route grants sent from the gateway to nodes.

### Zero-Downtime Key Rotation Sequence
Route grants are valid for only 30 seconds. Therefore, nodes cache verified grants for at most 30 seconds.

1. **Generate New Ed25519 Keypair:**
   ```bash
   node -e '
     const { generateKeyPairSync } = require("crypto");
     const { privateKey, publicKey } = generateKeyPairSync("ed25519");
     console.log("PRIVATE_KEY:\n" + privateKey.export({ type: "pkcs8", format: "pem" }));
     console.log("PUBLIC_KEY:\n" + publicKey.export({ type: "spki", format: "pem" }));
   '
   ```
2. **Deploy Dual Public Keys to Nodes:**
   Update node agent configuration with both Key N (current) and Key N+1 (new) trusted public keys. Node agents accept grants signed by either key.
3. **Switch Gateway Signing Key:**
   Update `CLOUDEXIFY_ROUTE_GRANT_PRIVATE_KEY` on the gateway to Key N+1.
4. **Wait 60 Seconds:**
   Allow all existing 30-second route grants to naturally expire and be replaced by Key N+1 grants.
5. **Retire Old Public Key:**
   Remove Key N from node configurations on the next routine maintenance cycle.

---

## 4. Node mTLS Tunnel Certificate Rotation

Node mTLS certificates authenticate outbound reverse tunnels to the gateway.

1. **Generate New Client Certificate & Fingerprint:**
   ```bash
   openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
     -nodes -keyout node-new.key -out node-new.csr \
     -subj "/CN=30000000-0000-4000-8000-000000000001"
   openssl x509 -req -in node-new.csr -CA gateway-ca.crt -CAkey gateway-ca.key \
     -CAcreateserial -out node-new.crt -days 365 -sha256
   FINGERPRINT=$(openssl x509 -in node-new.crt -outform DER | openssl dgst -sha256 | awk '{print $2}')
   ```
2. **Register New Fingerprint in Database:**
   ```sql
   INSERT INTO node_tunnel_certificates (tenant_id, node_id, sha256_fingerprint)
   VALUES ('<TENANT_UUID>', '30000000-0000-4000-8000-000000000001', '<FINGERPRINT>');
   ```
3. **Swap Certificate on Node & Reconnect:**
   Update certificate path in node environment and trigger restart. Gateway seamlessly accepts the new connection.
4. **Revoke Old Certificate:**
   ```sql
   UPDATE node_tunnel_certificates
   SET revoked_at = now()
   WHERE node_id = '30000000-0000-4000-8000-000000000001' AND sha256_fingerprint = '<OLD_FINGERPRINT>';
   ```

---

## 5. Supabase Auth API Keys Rotation

1. Navigate to Supabase Project Settings → **API**.
2. Generate secondary API Key for `anon` / `service_role`.
3. Update `SUPABASE_PUBLISHABLE_KEY` in Vercel Project Environment Variables.
4. Promote Vercel deployment.
5. Invalidate / delete old key in Supabase dashboard after verification.

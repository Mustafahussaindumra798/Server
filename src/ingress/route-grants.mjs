import { createPrivateKey, createPublicKey, sign, verify, randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value) {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Route grant is malformed.");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export function createRouteGrantSigner(privateKeyPem) {
  if (typeof privateKeyPem !== "string" || !privateKeyPem.trim()) throw new Error("CLOUDEXIFY_ROUTE_GRANT_PRIVATE_KEY is required.");
  const privateKey = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Route grant signing key must be Ed25519.");
  return (route, { now = Date.now(), ttlSeconds = 30 } = {}) => {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 5 || ttlSeconds > 60) throw new Error("Route grant lifetime must be 5–60 seconds.");
    const required = ["route_id", "tenant_id", "hostname", "deployment_id", "node_id", "local_port", "route_version"];
    if (!route || required.some((key) => route[key] == null) ||
        !UUID.test(route.route_id) || !UUID.test(route.tenant_id) ||
        !UUID.test(route.deployment_id) || !UUID.test(route.node_id) ||
        typeof route.hostname !== "string" || route.hostname.length > 253 ||
        !Number.isInteger(route.local_port) || route.local_port < 1 || route.local_port > 65535 ||
        !Number.isSafeInteger(Number(route.route_version)) || Number(route.route_version) < 1) {
      throw new Error("Route authorization record is incomplete or invalid.");
    }
    const claims = {
      version: 1,
      jti: randomUUID(),
      route_id: route.route_id,
      route_version: Number(route.route_version),
      tenant_id: route.tenant_id,
      hostname: route.hostname,
      deployment_id: route.deployment_id,
      node_id: route.node_id,
      upstream: { host: "127.0.0.1", port: route.local_port },
      iat: Math.floor(now / 1000),
      exp: Math.floor(now / 1000) + ttlSeconds
    };
    const payload = encode(claims);
    const signature = sign(null, Buffer.from(payload, "ascii"), privateKey).toString("base64url");
    return { token: payload + "." + signature, claims };
  };
}

export function verifyRouteGrant(token, publicKeyPem, {
  expectedNodeId,
  now = Date.now(),
  consumedJtis = new Set()
} = {}) {
  if (typeof token !== "string" || token.length > 8192 || typeof publicKeyPem !== "string" ||
      !UUID.test(expectedNodeId || "")) throw new Error("Route grant verification input is invalid.");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Route grant format is invalid.");
  const publicKey = createPublicKey(publicKeyPem.replace(/\\n/g, "\n"));
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("Route grant verification key must be Ed25519.");
  const valid = verify(null, Buffer.from(parts[0], "ascii"), publicKey, Buffer.from(parts[1], "base64url"));
  if (!valid) throw new Error("Route grant signature is invalid.");
  const claims = decode(parts[0]);
  const nowSeconds = Math.floor(now / 1000);
  if (claims.version !== 1 || !UUID.test(claims.jti || "") ||
      !UUID.test(claims.route_id || "") || !UUID.test(claims.tenant_id || "") ||
      !UUID.test(claims.deployment_id || "") || claims.node_id !== expectedNodeId ||
      typeof claims.hostname !== "string" || claims.hostname.length > 253 ||
      !Number.isSafeInteger(claims.route_version) || claims.route_version < 1 ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      claims.iat > nowSeconds + 5 || claims.exp <= nowSeconds ||
      claims.exp - claims.iat > 60 ||
      claims.upstream?.host !== "127.0.0.1" ||
      !Number.isInteger(claims.upstream?.port) || claims.upstream.port < 1 || claims.upstream.port > 65535) {
    throw new Error("Route grant claims are invalid, expired or not authorized for this node.");
  }
  if (consumedJtis.has(claims.jti)) throw new Error("Route grant replay was rejected.");
  consumedJtis.add(claims.jti);
  return claims;
}

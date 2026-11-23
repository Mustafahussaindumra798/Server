import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRouteGrantSigner, verifyRouteGrant } from "../src/ingress/route-grants.mjs";

const nodeId = "30000000-0000-4000-8000-000000000001";
const route = {
  route_id: "31000000-0000-4000-8000-000000000001",
  tenant_id: "20000000-0000-4000-8000-000000000001",
  hostname: "app.example.test",
  deployment_id: "50000000-0000-4000-8000-000000000001",
  node_id: nodeId,
  local_port: 32145,
  route_version: "7"
};
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signer = createRouteGrantSigner(privateKey.export({ type: "pkcs8", format: "pem" }));
const publicPem = publicKey.export({ type: "spki", format: "pem" });

test("route grant binds tenant, hostname, deployment, node, route version and loopback endpoint", () => {
  const { token, claims } = signer(route, { now: 1_800_000_000_000, ttlSeconds: 30 });
  assert.equal(claims.node_id, nodeId);
  assert.equal(claims.route_version, 7);
  assert.deepEqual(claims.upstream, { host: "127.0.0.1", port: 32145 });
  const verified = verifyRouteGrant(token, publicPem, { expectedNodeId: nodeId, now: 1_800_000_001_000 });
  assert.deepEqual(verified, claims);
});

test("route grant rejects wrong node, altered payload, expired grant and replay", () => {
  const { token } = signer(route, { now: 1_800_000_000_000, ttlSeconds: 10 });
  assert.throws(() => verifyRouteGrant(token, publicPem, {
    expectedNodeId: "30000000-0000-4000-8000-000000000002", now: 1_800_000_001_000
  }), /signature|authorized/);
  const [payload, signature] = token.split(".");
  const altered = Buffer.from(payload, "base64url").toString("utf8").replace("app.example.test", "evil.example.test");
  assert.throws(() => verifyRouteGrant(Buffer.from(altered).toString("base64url") + "." + signature, publicPem, {
    expectedNodeId: nodeId, now: 1_800_000_001_000
  }), /signature/);
  assert.throws(() => verifyRouteGrant(token, publicPem, { expectedNodeId: nodeId, now: 1_800_000_011_000 }), /expired/);
  const consumed = new Set();
  verifyRouteGrant(token, publicPem, { expectedNodeId: nodeId, now: 1_800_000_001_000, consumedJtis: consumed });
  assert.throws(() => verifyRouteGrant(token, publicPem, { expectedNodeId: nodeId, now: 1_800_000_002_000, consumedJtis: consumed }), /replay/);
});

test("route grant signer rejects arbitrary hosts, invalid ports and excessive lifetime", () => {
  assert.throws(() => signer({ ...route, local_port: 0 }));
  assert.throws(() => signer({ ...route, hostname: "" }));
  assert.throws(() => signer(route, { ttlSeconds: 61 }));
  assert.throws(() => signer({ ...route, upstream: "http://127.0.0.1:80" }));
});

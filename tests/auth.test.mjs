import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createOidcVerifier, getBearerToken, AuthenticationError } from "../src/auth/oidc.mjs";

const issuer = "https://identity.example.test/";
const audience = "cloudexify-control-plane";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = "test-key";
jwk.use = "sig";
jwk.alg = "RS256";
const now = 1_800_000_000_000;

function token(claimOverrides = {}, headerOverrides = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", kid: "test-key", ...headerOverrides });
  const claims = encode({ iss: issuer, aud: audience, sub: "user-123", exp: Math.floor(now / 1000) + 300, iat: Math.floor(now / 1000), ...claimOverrides });
  const input = header + "." + claims;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}

function verifier() {
  return createOidcVerifier({
    issuer, audience, jwksUri: "https://identity.example.test/jwks",
    clock: () => now,
    fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) })
  });
}

test("verifies a signed OIDC access token and creates issuer-scoped identity", async () => {
  const principal = await verifier()(token());
  assert.equal(principal.subject, "user-123");
  assert.equal(principal.identitySubject, issuer + "|user-123");
});

test("rejects a bad signature", async () => {
  const valid = token();
  const parts = valid.split(".");
  parts[2] = Buffer.alloc(256, 1).toString("base64url");
  await assert.rejects(() => verifier()(parts.join(".")), AuthenticationError);
});

test("rejects wrong issuer, audience and expired tokens", async () => {
  await assert.rejects(() => verifier()(token({ iss: "https://attacker.test" })), AuthenticationError);
  await assert.rejects(() => verifier()(token({ aud: "another-api" })), AuthenticationError);
  await assert.rejects(() => verifier()(token({ exp: Math.floor(now / 1000) - 100 })), AuthenticationError);
});

test("rejects unsupported algorithms", async () => {
  await assert.rejects(() => verifier()(token({}, { alg: "none" })), AuthenticationError);
});

test("extracts only a well-formed bearer token", () => {
  assert.equal(getBearerToken({ headers: { authorization: "Bearer abc.def_123" } }), "abc.def_123");
  assert.throws(() => getBearerToken({ headers: { authorization: "Basic abc" } }), AuthenticationError);
  assert.throws(() => getBearerToken({ headers: {} }), AuthenticationError);
});

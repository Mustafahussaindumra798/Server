import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createApiHandler } from "../src/api.mjs";

const issuer = "https://identity.example.test/";
const audience = "cloudexify-control-plane";
const tenantId = "20000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000001";
const appId = "40000000-0000-4000-8000-000000000001";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "api-test", use: "sig", alg: "RS256" };

function makeToken() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "RS256", kid: "api-test" });
  const body = encode({ iss: issuer, aud: audience, sub: "api-user", exp: Math.floor(Date.now() / 1000) + 300 });
  const input = head + "." + body;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}

function fakePool(role = "viewer") {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      const query = String(sql);
      if (query.startsWith("SELECT id, identity_subject")) {
        return { rows: [{ id: userId, identity_subject: issuer + "|api-user", email: "api@example.test", display_name: "API User" }], rowCount: 1 };
      }
      if (query.startsWith("SELECT id, status, approved_at FROM nodes")) return { rows: [{ id: params[0], status: "pending", approved_at: null }], rowCount: 1 };
      if (query.startsWith("UPDATE nodes SET approved_at = COALESCE(approved_at, now())")) return { rows: [{ id: params[0], status: "online", approved_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }], rowCount: 1 };
      if (query.startsWith("UPDATE nodes SET status = 'revoked', approved_at = NULL")) return { rows: [{ id: params[0], status: "revoked", approved_at: null, last_seen_at: null }], rowCount: 1 };
      if (query.startsWith("SELECT id, status, approved_at, last_seen_at, heartbeat_interval_seconds FROM nodes")) return { rows: [{ id: params[0], status: "online", approved_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), heartbeat_interval_seconds: 60 }], rowCount: 1 };
      if (query.startsWith("INSERT INTO jobs")) return { rows: [{ id: "60000000-0000-4000-8000-000000000001", tenant_id: tenantId, node_id: params[1], type: params[2], payload: JSON.parse(params[3]), status: "queued", attempt_count: 0, max_attempts: 5, created_at: new Date().toISOString() }], rowCount: 1 };
      if (query.startsWith("SELECT id, tenant_id, node_id, type, payload_json AS payload, status, attempt_count, max_attempts, created_at FROM jobs")) return { rows: [], rowCount: 0 };
      if (query.startsWith("SELECT id, node_id, type, payload_json AS payload, status, attempt_count, max_attempts, available_at, lease_expires_at, created_at, updated_at FROM jobs")) return { rows: [], rowCount: 0 };
      if (query.startsWith("SELECT membership.role")) {
        return { rows: [{ role, tenant_status: "active" }], rowCount: 1 };
      }
      if (query.startsWith("SELECT id, tenant_id, name, desired_state")) return { rows: [], rowCount: 0 };
      if (query.startsWith("SELECT COALESCE(MAX(revision)")) return { rows: [{ next_revision: 1 }], rowCount: 1 };
      if (query.startsWith("INSERT INTO deployments")) {
        return { rows: [{ id: "50000000-0000-4000-8000-000000000001", tenant_id: tenantId, application_id: appId, revision: 1, target_node_id: null, desired_state: "running", status: "queued", created_by: userId, created_at: new Date().toISOString() }], rowCount: 1 };
      }
      if (query.startsWith("INSERT INTO applications")) {
        return { rows: [{ id: appId, tenant_id: tenantId, name: params[1], desired_state: "stopped", created_by: userId, created_at: new Date().toISOString() }], rowCount: 1 };
      }
      if (query.startsWith("INSERT INTO enrollment_tokens")) return { rows: [{ id: "70000000-0000-4000-8000-000000000001", expires_at: new Date(Date.now() + 1800000).toISOString() }], rowCount: 1 };
      if (query.startsWith("UPDATE node_credentials")) return { rows: [{ id: "80000000-0000-4000-8000-000000000001", revoked_at: new Date().toISOString() }], rowCount: 1 };
      if (query.startsWith("SELECT count(*)::integer AS active_count")) return { rows: [{ active_count: 0 }], rowCount: 1 };
      if (query.startsWith("SELECT * FROM app_private.enroll_node")) return { rows: [{ node_id: "30000000-0000-4000-8000-000000000001", tenant_id: tenantId, credential_id: "80000000-0000-4000-8000-000000000001" }], rowCount: 1 };
      if (query.startsWith("SELECT * FROM app_private.accept_node_heartbeat")) return params[1] === createHash("sha256").update("node-credential-test-012345678901234567890123").digest("hex") ? { rows: [{ node_id: params[0], status: "online", last_seen_at: "2026-11-22T00:00:00.000Z" }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (query.startsWith("SELECT app_private.node_credential_is_valid")) return { rows: [{ valid: params[1] === createHash("sha256").update("node-credential-test-012345678901234567890123").digest("hex") }], rowCount: 1 };
      if (query.startsWith("SELECT * FROM app_private.claim_node_jobs")) return params[1] === createHash("sha256").update("node-credential-test-012345678901234567890123").digest("hex") ? { rows: [{ job_id: "60000000-0000-4000-8000-000000000001", job_type: "probe", payload: {}, attempt_id: "70000000-0000-4000-8000-000000000001", lease_token: "80000000-0000-4000-8000-000000000001", lease_expires_at: new Date(Date.now() + 60000).toISOString(), attempt_number: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (query.startsWith("SELECT * FROM app_private.acknowledge_node_job")) return params[1] === createHash("sha256").update("node-credential-test-012345678901234567890123").digest("hex") ? { rows: [{ job_id: params[2], status: params[5], attempt_id: params[3], retry_at: null }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (query.startsWith("INSERT INTO audit_events")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {}
  };
  return { calls, connect: async () => client };
}

async function startApi(role = "viewer") {
  const pool = fakePool(role);
  const handler = createApiHandler({
    pool,
    env: { OIDC_ISSUER: issuer, OIDC_AUDIENCE: audience, OIDC_JWKS_URI: "https://identity.example.test/jwks" },
    fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }),
    logger: { error() {} }
  });
  const server = http.createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  return { pool, origin, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

test("viewer can read tenant applications", async (t) => {
  const api = await startApi("viewer");
  t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/applications", {
    headers: { authorization: "Bearer " + makeToken() }
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).applications, []);
});

test("viewer cannot create an application", async (t) => {
  const api = await startApi("viewer");
  t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/applications", {
    method: "POST",
    headers: { authorization: "Bearer " + makeToken(), "content-type": "application/json" },
    body: JSON.stringify({ name: "Forbidden app" })
  });
  assert.equal(response.status, 403);
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("INSERT INTO applications")), false);
});

test("operator can request a deployment and it is audited", async (t) => {
  const api = await startApi("operator");
  t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/deployments", {
    method: "POST",
    headers: { authorization: "Bearer " + makeToken(), "content-type": "application/json" },
    body: JSON.stringify({ application_id: appId, desired_state: "running" })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).deployment.status, "queued");
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("INSERT INTO audit_events")), true);
});

test("API rejects requests without a bearer token", async (t) => {
  const api = await startApi("owner");
  t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants");
  assert.equal(response.status, 401);
});

test("API rejects an unapproved browser origin", async (t) => {
  const api = await startApi("owner");
  t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants", {
    headers: { origin: "https://attacker.example", authorization: "Bearer " + makeToken() }
  });
  assert.equal(response.status, 403);
});


test("owner creates a hashed, time-limited enrollment token", async (t) => {
  const api = await startApi("owner"); t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/enrollment-tokens", {
    method: "POST", headers: { authorization: "Bearer " + makeToken(), "content-type": "application/json" },
    body: JSON.stringify({ expires_in_minutes: 45 })
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  const insert = api.pool.calls.find((call) => call.sql.startsWith("INSERT INTO enrollment_tokens"));
  assert.match(insert.params[1], /^[a-f0-9]{64}$/);
  assert.equal(insert.params[1], createHash("sha256").update(payload.enrollment_token.token).digest("hex"));
  assert.equal(insert.params[2], 45);
});

test("viewer cannot create node enrollment tokens", async (t) => {
  const api = await startApi("viewer"); t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/enrollment-tokens", {
    method: "POST", headers: { authorization: "Bearer " + makeToken(), "content-type": "application/json" }, body: "{}"
  });
  assert.equal(response.status, 403);
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("INSERT INTO enrollment_tokens")), false);
});

test("node enrollment hashes bootstrap token and returns one-time credential", async (t) => {
  const api = await startApi("viewer"); t.after(api.close);
  const token = "single-use-bootstrap-token";
  const response = await fetch(api.origin + "/api/v1/nodes/enroll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollment_token: token, name: "android-edge-01", platform: "android", architecture: "aarch64", capabilities: { memory_mb: 4096 } })
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.node.status, "pending");
  const call = api.pool.calls.find((item) => item.sql.startsWith("SELECT * FROM app_private.enroll_node"));
  assert.equal(call.params[0], createHash("sha256").update(token).digest("hex"));
  assert.match(call.params[6], /^[a-f0-9]{64}$/);
  assert.notEqual(call.params[6], payload.credential.secret);
});

test("owner can revoke a node credential and revoke its node when no active credential remains", async (t) => {
  const api = await startApi("owner"); t.after(api.close);
  const nodeId = "30000000-0000-4000-8000-000000000001";
  const credentialId = "80000000-0000-4000-8000-000000000001";
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/nodes/" + nodeId + "/credentials/" + credentialId + "/revoke", {
    method: "POST", headers: { authorization: "Bearer " + makeToken() }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).node_status, "revoked");
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("UPDATE nodes SET status = 'revoked'")), true);
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("INSERT INTO audit_events") && call.params[2] === "node.credential.revoked"), true);
});



test("owner can approve a pending node and the action is audited", async (t) => {
  const api = await startApi("owner"); t.after(api.close);
  const nodeId = "30000000-0000-4000-8000-000000000001";
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/nodes/" + nodeId + "/approve", {
    method: "POST", headers: { authorization: "Bearer " + makeToken() }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).node.id, nodeId);
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("UPDATE nodes SET approved_at = COALESCE(approved_at, now())")), true);
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("INSERT INTO audit_events") && call.params[2] === "node.approved"), true);
});

test("viewer cannot approve or reject nodes", async (t) => {
  const api = await startApi("viewer"); t.after(api.close);
  for (const action of ["approve", "reject"]) {
    const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/nodes/30000000-0000-4000-8000-000000000001/" + action, {
      method: "POST", headers: { authorization: "Bearer " + makeToken() }
    });
    assert.equal(response.status, 403);
  }
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("UPDATE nodes SET approved_at")), false);
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("UPDATE node_credentials SET revoked_at")), false);
});

test("owner rejection revokes all active node credentials and audits the rejection", async (t) => {
  const api = await startApi("owner"); t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/nodes/30000000-0000-4000-8000-000000000001/reject", {
    method: "POST", headers: { authorization: "Bearer " + makeToken() }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).node.status, "revoked");
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("UPDATE node_credentials SET revoked_at = COALESCE(revoked_at, now())")), true);
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("INSERT INTO audit_events") && call.params[2] === "node.rejected"), true);
});

test("node heartbeat authenticates credentials and stores validated resource metrics", async (t) => {
  const api = await startApi("viewer"); t.after(api.close); const nodeId = "30000000-0000-4000-8000-000000000001";
  const response = await fetch(api.origin + "/api/v1/nodes/" + nodeId + "/heartbeat", { method: "POST", headers: { authorization: "Bearer node-credential-test-012345678901234567890123", "content-type": "application/json" }, body: JSON.stringify({ health_status: "healthy", agent_version: "0.1.0", resources: { cpu_percent: 21.5, memory_total_bytes: 4096, memory_used_bytes: 2048, uptime_seconds: 120 } }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).node.status, "online");
  const call = api.pool.calls.find((item) => item.sql.startsWith("SELECT * FROM app_private.accept_node_heartbeat"));
  assert.equal(call.params[0], nodeId); assert.equal(call.params[1], createHash("sha256").update("node-credential-test-012345678901234567890123").digest("hex"));
  assert.deepEqual(JSON.parse(call.params[4]), { cpu_percent: 21.5, memory_total_bytes: 4096, memory_used_bytes: 2048, uptime_seconds: 120 });
});

test("node heartbeat rejects missing, invalid, revoked or expired credentials", async (t) => {
  const api = await startApi("viewer"); t.after(api.close); const nodeId = "30000000-0000-4000-8000-000000000001";
  for (const authorization of [undefined, "Bearer revoked-node-credential-0123456789012345"]) {
    const headers = { "content-type": "application/json" }; if (authorization) headers.authorization = authorization;
    const response = await fetch(api.origin + "/api/v1/nodes/" + nodeId + "/heartbeat", { method: "POST", headers, body: JSON.stringify({ health_status: "healthy", resources: {} }) });
    assert.equal(response.status, 401);
  }
});

test("node heartbeat rejects invalid health and resource metrics", async (t) => {
  const api = await startApi("viewer"); t.after(api.close); const nodeId = "30000000-0000-4000-8000-000000000001";
  for (const body of [{ health_status: "unknown", resources: {} }, { health_status: "healthy", resources: { shell_command: 1 } }, { health_status: "healthy", resources: { cpu_percent: 101 } }, { health_status: "healthy", resources: { memory_used_bytes: "large" } }]) {
    const response = await fetch(api.origin + "/api/v1/nodes/" + nodeId + "/heartbeat", { method: "POST", headers: { authorization: "Bearer node-credential-test-012345678901234567890123", "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
});


test("operator creates a typed, idempotent-safe diagnostic job for an online approved node", async (t) => {
  const api = await startApi("operator"); t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/jobs", {
    method: "POST",
    headers: { authorization: "Bearer " + makeToken(), "content-type": "application/json" },
    body: JSON.stringify({ node_id: "30000000-0000-4000-8000-000000000001", type: "probe", payload: {}, idempotency_key: "probe-node-a-01" })
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.job.type, "probe");
  assert.equal(payload.job.status, "queued");
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("INSERT INTO audit_events") && call.params[2] === "node.job.created"), true);
});

test("job creation rejects shell commands and non-empty diagnostic payloads", async (t) => {
  const api = await startApi("owner"); t.after(api.close);
  for (const body of [
    { node_id: "30000000-0000-4000-8000-000000000001", type: "shell", payload: { command: "id" }, idempotency_key: "bad-shell-01" },
    { node_id: "30000000-0000-4000-8000-000000000001", type: "probe", payload: { command: "id" }, idempotency_key: "bad-payload-01" }
  ]) {
    const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/jobs", {
      method: "POST", headers: { authorization: "Bearer " + makeToken(), "content-type": "application/json" }, body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
  }
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("INSERT INTO jobs")), false);
});

test("viewer cannot create node jobs", async (t) => {
  const api = await startApi("viewer"); t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/tenants/" + tenantId + "/jobs", {
    method: "POST", headers: { authorization: "Bearer " + makeToken(), "content-type": "application/json" },
    body: JSON.stringify({ node_id: "30000000-0000-4000-8000-000000000001", type: "probe", payload: {}, idempotency_key: "probe-denied-01" })
  });
  assert.equal(response.status, 403);
  assert.equal(api.pool.calls.some((call) => call.sql.startsWith("INSERT INTO jobs")), false);
});

test("node polls jobs using its credential and bounded lease parameters", async (t) => {
  const api = await startApi("viewer"); t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/nodes/30000000-0000-4000-8000-000000000001/jobs/claim", {
    method: "POST", headers: { authorization: "Bearer node-credential-test-012345678901234567890123", "content-type": "application/json" },
    body: JSON.stringify({ limit: 2, lease_seconds: 90 })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.jobs[0].job_type, "probe");
  const call = api.pool.calls.find((item) => item.sql.startsWith("SELECT * FROM app_private.claim_node_jobs"));
  assert.equal(call.params[2], 2);
  assert.equal(call.params[3], 90);
});

test("node acknowledgement requires a valid lease and reports lifecycle state", async (t) => {
  const api = await startApi("viewer"); t.after(api.close);
  const response = await fetch(api.origin + "/api/v1/nodes/30000000-0000-4000-8000-000000000001/jobs/60000000-0000-4000-8000-000000000001/ack", {
    method: "POST", headers: { authorization: "Bearer node-credential-test-012345678901234567890123", "content-type": "application/json" },
    body: JSON.stringify({ attempt_id: "70000000-0000-4000-8000-000000000001", lease_token: "80000000-0000-4000-8000-000000000001", status: "succeeded", result_code: "ok", result_summary: "Probe completed" })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).job.status, "succeeded");
});

test("node job endpoints reject missing credentials and invalid lease bounds", async (t) => {
  const api = await startApi("viewer"); t.after(api.close);
  const missing = await fetch(api.origin + "/api/v1/nodes/30000000-0000-4000-8000-000000000001/jobs/claim", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert.equal(missing.status, 401);
  const invalid = await fetch(api.origin + "/api/v1/nodes/30000000-0000-4000-8000-000000000001/jobs/claim", {
    method: "POST", headers: { authorization: "Bearer node-credential-test-012345678901234567890123", "content-type": "application/json" },
    body: JSON.stringify({ limit: 99 })
  });
  assert.equal(invalid.status, 400);
});

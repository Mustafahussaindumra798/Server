import test from "node:test";
import assert from "node:assert/strict";
import { createHealthHandler } from "../api/health.mjs";

function response() {
  return {
    headers: {},
    statusCode: 0,
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; }
  };
}

const readySchema = {
  applications_table: true,
  deployments_table: true,
  nodes_table: true,
  application_resource_requests: true,
  deployment_resource_requests: true,
  node_resource_metrics: true,
  heartbeat_function: true,
  claim_jobs_function: true,
  acknowledge_job_function: true,
  capability_heartbeat_function: true
};

test("health reports ready only when the existing control-plane schema is complete", async () => {
  const pool = { query: async () => ({ rows: [readySchema] }) };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    status: "ok",
    service: "cloudexify-control-plane",
    database: "connected",
    schema: "ready",
    resource_admission: "ready"
  });
});

test("health identifies migration 007 without exposing database details", async () => {
  const pool = { query: async () => ({ rows: [{ ...readySchema, application_resource_requests: false, deployment_resource_requests: false }] }) };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), {
    status: "migration_required",
    service: "cloudexify-control-plane",
    database: "connected",
    schema: "partial",
    pending_migrations: ["007_resource_admission"]
  });
});

test("health identifies migration 008 when runtime capability heartbeats are not installed", async () => {
  const pool = { query: async () => ({ rows: [{ ...readySchema, capability_heartbeat_function: false }] }) };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body).pending_migrations, ["008_runtime_capability_heartbeat"]);
});

test("health handles unavailable database connections without leaking errors", async () => {
  const pool = { query: async () => { throw new Error("private connection detail"); } };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.includes("private connection detail"), false);
  assert.equal(JSON.parse(res.body).database, "unavailable");
});

test("health reports missing database configuration", async () => {
  const res = response();
  await createHealthHandler(null)({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).status, "not_configured");
});

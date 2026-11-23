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
  capability_heartbeat_function: true,
  deployment_image_digest: true,
  deployment_container_port: true,
  deployment_job_reconciliation: true,
  deployment_job_cancellation: true,
  deployment_health_check_path: true,
  deployment_health_check_timeout: true,
  deployment_health_checked_at: true,
  deployment_health_reconciliation: true,
  deployment_stop_reconciliation: true,
  deployment_restart_reconciliation: true,
  runtime_reconciliation_function: true,
  deployment_automatic_rollback: true,
  deployment_rollback_reconciliation: true,
  deployment_runtime_local_port: true,
  job_attempt_result_json: true,
  deployment_endpoint_registration: true
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
    resource_admission: "ready",
    runtime_capabilities: "ready",
    deployment_job_orchestration: "ready",
    deployment_health_checks: "ready",
    deployment_lifecycle_jobs: "ready",
    durable_runtime_reconciliation: "ready",
    automatic_deployment_rollback: "ready"
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

test("health identifies migration 009 when deployment job orchestration is incomplete", async () => {
  const pool = { query: async () => ({ rows: [{ ...readySchema, deployment_job_cancellation: false }] }) };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body).pending_migrations, ["009_deployment_job_orchestration"]);
});

test("health identifies migration 010 when deployment health-check columns are missing", async () => {
  const pool = { query: async () => ({ rows: [{ ...readySchema, deployment_health_reconciliation: false }] }) };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body).pending_migrations, ["010_deployment_health_checks"]);
});

test("health identifies migration 011 when stop/restart reconciliation is missing", async () => {
  const pool = { query: async () => ({ rows: [{ ...readySchema, deployment_stop_reconciliation: false }] }) };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body).pending_migrations, ["011_deployment_lifecycle_jobs"]);
});

test("health identifies migration 012 when durable runtime reconciliation is missing", async () => {
  const pool = { query: async () => ({ rows: [{ ...readySchema, runtime_reconciliation_function: false }] }) };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body).pending_migrations, ["012_durable_runtime_reconciliation"]);
});

test("health identifies migration 013 when automatic rollback is not installed", async () => {
  const pool = { query: async () => ({ rows: [{ ...readySchema, deployment_automatic_rollback: false, deployment_rollback_reconciliation: false }] }) };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body).pending_migrations, ["013_automatic_deployment_rollback"]);
});

test("health identifies migration 014 when runtime endpoint registration is incomplete", async () => {
  const pool = { query: async () => ({ rows: [{ ...readySchema, deployment_endpoint_registration: false }] }) };
  const res = response();
  await createHealthHandler(pool)({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body).pending_migrations, ["014_runtime_endpoint_registration"]);
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

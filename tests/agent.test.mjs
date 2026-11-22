import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, lstat, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getLinuxIdentity, validateControlPlaneUrl, readLinuxMetrics } from "../src/agent/linux.mjs";
import { loadAgentState, saveAgentState } from "../src/agent/state.mjs";
import { executeDiagnostic, enrollNode } from "../agent.mjs";

const validState = {
  node_id: "30000000-0000-4000-8000-000000000001",
  credential: "A".repeat(48),
  control_plane_url: "https://control.example.test",
  node_name: "linux-test-node"
};

test("Linux identity accepts only supported 64-bit architectures", () => {
  assert.deepEqual(getLinuxIdentity("linux", "x64"), { platform: "linux", architecture: "x86_64" });
  assert.deepEqual(getLinuxIdentity("linux", "arm64"), { platform: "linux", architecture: "aarch64" });
  assert.throws(() => getLinuxIdentity("win32", "x64"), /requires a Linux host/);
  assert.throws(() => getLinuxIdentity("linux", "ia32"), /Unsupported Linux architecture/);
});

test("control-plane URL requires HTTPS except loopback development", () => {
  assert.equal(validateControlPlaneUrl("https://control.example.test/"), "https://control.example.test");
  assert.equal(validateControlPlaneUrl("http://127.0.0.1:4173"), "http://127.0.0.1:4173");
  assert.throws(() => validateControlPlaneUrl("http://control.example.test"), /must use HTTPS/);
  assert.throws(() => validateControlPlaneUrl("https://user:pass@control.example.test"), /must not contain credentials/);
});

test("agent state is atomically stored with owner-only permissions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudexify-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await saveAgentState(directory, validState);
  const info = await lstat(path.join(directory, "node.json"));
  assert.equal(info.mode & 0o777, 0o600);
  assert.deepEqual(await loadAgentState(directory), validState);
});

test("agent refuses a credential file with group or world permissions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudexify-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await saveAgentState(directory, validState);
  await chmod(path.join(directory, "node.json"), 0o644);
  await assert.rejects(loadAgentState(directory), /permissions are too open/);
});

test("agent refuses symlinked credential files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudexify-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "elsewhere"), JSON.stringify(validState));
  await symlink(path.join(directory, "elsewhere"), path.join(directory, "node.json"));
  await assert.rejects(loadAgentState(directory), /symlink/);
});

test("agent refuses a symlinked state directory", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "cloudexify-agent-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const actual = path.join(parent, "actual");
  const link = path.join(parent, "link");
  await mkdir(actual);
  await symlink(actual, link);
  await assert.rejects(saveAgentState(link, validState), /symlink/);
});

test("Linux metrics return only finite non-negative allowlisted values", async () => {
  const metrics = await readLinuxMetrics();
  assert.ok(Number.isFinite(metrics.uptime_seconds) && metrics.uptime_seconds >= 0);
  for (const [key, value] of Object.entries(metrics)) {
    assert.ok(["uptime_seconds", "memory_total_bytes", "memory_used_bytes", "disk_total_bytes", "disk_available_bytes", "load_1m", "cpu_percent"].includes(key));
    assert.ok(Number.isFinite(value) && value >= 0, key);
  }
  if (metrics.cpu_percent !== undefined) assert.ok(metrics.cpu_percent <= 100);
  if (metrics.memory_total_bytes !== undefined && metrics.memory_used_bytes !== undefined) assert.ok(metrics.memory_used_bytes <= metrics.memory_total_bytes);
});

test("probe diagnostic calls only the control-plane health endpoint", async () => {
  const calls = [];
  const result = await executeDiagnostic({ job_type: "probe", payload: {} }, {
    controlPlaneUrl: "https://control.example.test",
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.deepEqual(calls, ["https://control.example.test/api/health"]);
  assert.equal(result.result_code, "control_plane_reachable");
});

test("diagnostic handler rejects arbitrary command-like payloads", async () => {
  await assert.rejects(executeDiagnostic({ job_type: "probe", payload: { command: "id" } }), /Unsupported or malformed/);
  await assert.rejects(executeDiagnostic({ job_type: "shell", payload: { command: "id" } }), /Unsupported or malformed/);
});

test("enrollment stores the credential only after a successful control-plane response", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudexify-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const result = await enrollNode({
    controlPlaneUrl: "https://control.example.test",
    enrollmentToken: "one-time-enrollment-token",
    nodeName: "ci-linux-node",
    stateDirectory: directory,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({
        node: { id: validState.node_id, name: "ci-linux-node", status: "pending" },
        credential: { secret: validState.credential }
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
  });
  assert.equal(result.node.status, "pending");
  assert.equal(calls[0].url, "https://control.example.test/api/v1/nodes/enroll");
  assert.equal(JSON.parse(calls[0].options.body).platform, "linux");
  assert.deepEqual(await loadAgentState(directory), { ...validState, enrolled_at: (await loadAgentState(directory)).enrolled_at });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, lstat, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getLinuxIdentity, getCapabilities, detectPodmanRuntime, validateControlPlaneUrl, readLinuxMetrics } from "../src/agent/linux.mjs";
import { loadAgentState, saveAgentState } from "../src/agent/state.mjs";
import { executeDiagnostic, executeWorkloadJob, enrollNode, runAgent } from "../agent.mjs";

const validState = {
  node_id: "30000000-0000-4000-8000-000000000001",
  credential: "A".repeat(48),
  control_plane_url: "https://control.example.test",
  node_name: "linux-test-node"
};

test("Linux identity accepts only supported 64-bit architectures", () => {
  assert.deepEqual(getLinuxIdentity("linux", "x64"), { platform: "linux", architecture: "x86_64", environment: "linux" });
  assert.deepEqual(getLinuxIdentity("linux", "arm64"), { platform: "linux", architecture: "aarch64", environment: "linux" });
  assert.deepEqual(getLinuxIdentity("linux", "arm64", { TERMUX_VERSION: "0.118" }), { platform: "android", architecture: "aarch64", environment: "termux" });
  assert.deepEqual(getLinuxIdentity("linux", "arm64", { PREFIX: "/data/data/com.termux/files/usr" }), { platform: "android", architecture: "aarch64", environment: "termux" });
  assert.deepEqual(getLinuxIdentity("android", "arm64", { TERMUX_VERSION: "0.118" }), { platform: "android", architecture: "aarch64", environment: "termux" });
  assert.deepEqual(getLinuxIdentity("android", "arm64", { PREFIX: "/data/data/com.termux/files/usr" }), { platform: "android", architecture: "aarch64", environment: "termux" });
  assert.throws(() => getLinuxIdentity("android", "arm64", {}), /Linux or Android running Termux/);
  assert.throws(() => getLinuxIdentity("win32", "x64"), /Linux or Android running Termux/);
  assert.throws(() => getLinuxIdentity("linux", "ia32"), /Unsupported Linux\/Android architecture/);
});

test("agent dispatches typed deploy, stop and restart jobs to the workload runtime", async () => {
  const calls = [];
  const runtime = {
    async deploy(payload) { calls.push(["deploy", payload]); return { result_code: "started" }; },
    async stop(id) { calls.push(["stop", id]); return { result_code: "stopped" }; },
    async restart(id) { calls.push(["restart", id]); return { result_code: "restarted" }; }
  };
  const deploymentId = "40000000-0000-4000-8000-000000000001";
  const deployPayload = { deployment_id: deploymentId, image: "immutable" };
  assert.equal((await executeWorkloadJob({ job_type: "deploy", payload: deployPayload }, { runtime })).result_code, "started");
  assert.equal((await executeWorkloadJob({ job_type: "stop", payload: { deployment_id: deploymentId } }, { runtime })).result_code, "stopped");
  assert.equal((await executeWorkloadJob({ job_type: "restart", payload: { deployment_id: deploymentId } }, { runtime })).result_code, "restarted");
  assert.deepEqual(calls, [["deploy", deployPayload], ["stop", deploymentId], ["restart", deploymentId]]);
});

test("agent rejects malformed workload jobs and never accepts arbitrary command payloads", async () => {
  const runtime = { async deploy() { throw new Error("must not execute"); }, async stop() {}, async restart() {} };
  await assert.rejects(executeWorkloadJob({ job_type: "exec", payload: { command: "id" } }, { runtime }), /Unsupported or malformed/);
  await assert.rejects(executeWorkloadJob({ job_type: "stop", payload: { deployment_id: "id", command: "id" } }, { runtime }), /payload is malformed/);
  await assert.rejects(executeWorkloadJob({ job_type: "deploy", payload: {} }), /runtime is not configured/);
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
    assert.ok(["uptime_seconds", "cpu_cores", "cpu_frequency_mhz", "memory_total_bytes", "memory_used_bytes", "memory_available_bytes", "disk_total_bytes", "disk_used_bytes", "disk_available_bytes", "android_shared_storage_total_bytes", "android_shared_storage_used_bytes", "android_shared_storage_available_bytes", "load_1m", "cpu_percent", "battery_percent", "temperature_c"].includes(key));
    assert.ok(Number.isFinite(value) && value >= 0, key);
  }
  if (metrics.cpu_percent !== undefined) assert.ok(metrics.cpu_percent <= 100);
  assert.ok(Number.isInteger(metrics.cpu_cores) && metrics.cpu_cores >= 1 && metrics.cpu_cores <= 256);
  if (metrics.memory_total_bytes !== undefined) { assert.ok(metrics.memory_used_bytes <= metrics.memory_total_bytes); assert.ok(metrics.memory_available_bytes <= metrics.memory_total_bytes); assert.equal(metrics.memory_used_bytes + metrics.memory_available_bytes, metrics.memory_total_bytes); }
  if (metrics.disk_total_bytes !== undefined) { assert.ok(metrics.disk_used_bytes <= metrics.disk_total_bytes); assert.ok(metrics.disk_available_bytes <= metrics.disk_total_bytes); }
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
  assert.deepEqual(await loadAgentState(directory), { ...validState, node_name: "ci-linux-node", enrolled_at: (await loadAgentState(directory)).enrolled_at });
});

test("agent sends heartbeat and polls its own node queue", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudexify-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await saveAgentState(directory, validState);
  const controller = new AbortController();
  const calls = [];
  const logs = [];
  await runAgent({
    stateDirectory: directory, signal: controller.signal, heartbeatSeconds: 15, pollSeconds: 5,
    onLog: (level, message, fields) => logs.push({ level, message, fields }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/jobs/claim")) controller.abort();
      const payload = url.endsWith("/heartbeat") ? { node: { status: "pending" } } : { jobs: [] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  assert.ok(calls.some((call) => call.url.endsWith("/heartbeat")));
  const heartbeatCall = calls.find((call) => call.url.endsWith("/heartbeat"));
  const heartbeatBody = JSON.parse(heartbeatCall.options.body);
  assert.equal(heartbeatBody.capabilities.workload_execution, false);
  assert.deepEqual(heartbeatBody.capabilities.diagnostics, ["probe", "collect_metrics"]);
  assert.equal(typeof heartbeatBody.capabilities.runtime_probe.podman.ready, "boolean");
  assert.ok(calls.some((call) => call.url.endsWith("/jobs/claim")));
  for (const call of calls) assert.equal(call.options.headers.authorization, "Bearer " + validState.credential);
  assert.equal(JSON.stringify(logs).includes(validState.credential), false);
});

test("agent stops when the control plane rejects its node credential", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudexify-agent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await saveAgentState(directory, validState);
  await assert.rejects(runAgent({
    stateDirectory: directory, onLog: () => {},
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "Node credential is invalid, expired or revoked." } }),
      { status: 401, headers: { "content-type": "application/json" } })
  }), /invalid, expired or revoked/);
});

test("Podman runtime probe requires rootless mode and cgroup v2", async () => {
  const runtime = await detectPodmanRuntime({
    runCommand: async (command, args, options) => {
      assert.equal(command, "podman");
      assert.deepEqual(args, ["info", "--format", "json"]);
      assert.equal(options.timeout, 3000);
      return { stdout: JSON.stringify({
        host: { security: { rootless: true }, cgroupVersion: "v2" },
        version: { Version: "5.0.1" }
      }) };
    },
    readCgroupControllers: async () => "cpu memory pids"
  });
  assert.deepEqual(runtime, {
    available: true, ready: true, version: "5.0.1", rootless: true,
    cgroup_version: "v2", cgroup_v2_available: true, reason: null
  });
});

test("Podman runtime probe fails closed when rootless or cgroup v2 requirements are missing", async () => {
  const notRootless = await detectPodmanRuntime({
    runCommand: async () => ({ stdout: JSON.stringify({
      host: { security: { rootless: false }, cgroupVersion: "v2" },
      version: { Version: "5.0.1" }
    }) }),
    readCgroupControllers: async () => "cpu memory"
  });
  assert.equal(notRootless.ready, false);
  assert.equal(notRootless.reason, "podman_not_rootless");

  const noCgroupV2 = await detectPodmanRuntime({
    runCommand: async () => ({ stdout: JSON.stringify({
      host: { security: { rootless: true }, cgroupVersion: "v1" },
      version: { Version: "5.0.1" }
    }) }),
    readCgroupControllers: async () => { throw new Error("not mounted"); }
  });
  assert.equal(noCgroupV2.ready, false);
  assert.equal(noCgroupV2.reason, "cgroup_v2_unavailable");
});

test("Podman runtime probe handles missing binary and malformed output without throwing", async () => {
  const missing = await detectPodmanRuntime({ runCommand: async () => { throw new Error("ENOENT"); } });
  assert.equal(missing.available, false);
  assert.equal(missing.ready, false);
  const malformed = await detectPodmanRuntime({ runCommand: async () => ({ stdout: "not-json" }) });
  assert.equal(malformed.available, false);
  assert.equal(malformed.ready, false);
});

test("agent advertises diagnostics and detected runtime without claiming workload execution", async () => {
  const capabilities = await getCapabilities(
    getLinuxIdentity("linux", "x64"),
    { podmanProbe: async () => ({ available: true, ready: true, version: "5.0.1", rootless: true, cgroup_version: "v2", cgroup_v2_available: true, reason: null }) }
  );
  assert.deepEqual(capabilities.diagnostics, ["probe", "collect_metrics"]);
  assert.equal(capabilities.container_runtime, "podman-rootless");
  assert.equal(capabilities.runtime_probe.podman.ready, true);
  assert.equal(capabilities.workload_execution, false);
  assert.ok(capabilities.service_manager === null || capabilities.service_manager === "systemd");
});

test("Termux never probes or advertises a container runtime", async () => {
  let probed = false;
  const capabilities = await getCapabilities(
    getLinuxIdentity("linux", "arm64", { TERMUX_VERSION: "0.118" }),
    { podmanProbe: async () => { probed = true; return { available: true, ready: true }; } }
  );
  assert.equal(probed, false);
  assert.equal(capabilities.container_runtime, null);
  assert.equal(capabilities.workload_execution, false);
});

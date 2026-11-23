import test from "node:test";
import assert from "node:assert/strict";
import { PodmanWorkloadRuntime, validateDeploymentPayload } from "../src/agent/runtime.mjs";

const deploymentId = "40000000-0000-4000-8000-000000000001";
const digest = "registry.example.com/cloudexify/demo@sha256:" + "a".repeat(64);
const payload = {
  deployment_id: deploymentId,
  image: digest,
  container_port: 8080,
  resources: { cpu_millicores: 500, memory_bytes: 256 * 1024 * 1024, disk_bytes: 1024 * 1024 * 1024 }
};
const qualified = async () => ({ ready: true, rootless: true, cgroup_version: "v2", cgroup_v2_available: true, storage_quota: { ready: true } });

test("deployment manifests require immutable OCI digests and bounded resource requests", () => {
  assert.equal(validateDeploymentPayload(payload).container_name, "cloudexify-" + deploymentId);
  assert.throws(() => validateDeploymentPayload({ ...payload, image: "nginx:latest" }), /immutable OCI SHA-256 digest/);
  assert.throws(() => validateDeploymentPayload({ ...payload, container_port: 0 }), /Container port/);
  assert.throws(() => validateDeploymentPayload({ ...payload, resources: { cpu_millicores: 0, memory_bytes: 1 } }), /CPU and memory/);
  assert.throws(() => validateDeploymentPayload({ ...payload, command: "sh -c whoami" }), /unsupported fields/);
  assert.throws(() => validateDeploymentPayload({ ...payload, health_check_path: "//evil.example" }), /safe absolute path/);
  assert.throws(() => validateDeploymentPayload({ ...payload, health_check_timeout_seconds: 121 }), /5 to 120 seconds/);
});

test("runtime refuses to execute when rootless Podman and cgroup v2 are not qualified", async () => {
  const runtime = new PodmanWorkloadRuntime({
    runtimeProbe: async () => ({ ready: false, rootless: false, cgroup_version: "v1", cgroup_v2_available: false }),
    runCommand: async () => { throw new Error("must not invoke Podman"); }
  });
  await assert.rejects(runtime.deploy(payload), /not qualified/);
});

test("runtime refuses deployment when per-container storage quota is not qualified", async () => {
  const calls = [];
  const runtime = new PodmanWorkloadRuntime({
    runtimeProbe: async () => ({ ready: true, rootless: true, cgroup_version: "v2", cgroup_v2_available: true, storage_quota: { ready: false } }),
    runCommand: async (_binary, args) => { calls.push(args); throw new Error("must not invoke Podman"); }
  });
  await assert.rejects(runtime.deploy(payload), /storage quotas/);
  assert.equal(calls.length, 0);
});

test("deployment starts with bounded, isolated Podman arguments and confirms running state", async () => {
  const calls = [];
  let running = false;
  const runCommand = async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect") {
      if (!running) { const error = new Error("missing"); error.stderr = "no such object"; throw error; }
      return { stdout: JSON.stringify([{ State: { Running: true }, NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] } } }]) };
    }
    if (args[0] === "run") { running = true; return { stdout: "container-id" }; }
    return { stdout: "" };
  };
  const runtime = new PodmanWorkloadRuntime({ runCommand, runtimeProbe: qualified, fetchImpl: async (url, options) => { assert.equal(url, "http://127.0.0.1:49152/"); assert.equal(options.method, "GET"); return { status: 200 }; } });
  const result = await runtime.deploy(payload);
  assert.equal(result.result_code, "workload_healthy");
  assert.equal(result.local_port, 49152);
  assert.equal(result.health.status_code, 200);
  const runArgs = calls.find((args) => args[0] === "run");
  for (const required of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--network=slirp4netns", "--user=10001:10001"]) {
    assert.ok(runArgs.includes(required), "missing " + required);
  }
  assert.ok(runArgs.includes("127.0.0.1::8080/tcp"));
  assert.ok(runArgs.includes("--storage-opt=size=1073741824"));
  assert.equal(runArgs.some((arg) => arg.includes("sh -c") || arg.startsWith("--volume")), false);
  const signatureCheck = calls.find((args) => args[0] === "verify");
  assert.deepEqual(signatureCheck, ["verify", "--key", "/etc/cloudexify/trust.pub", digest]);
});

test("stop confirms process termination and is idempotent", async () => {
  let running = true;
  const runCommand = async (_command, args) => {
    if (args[0] === "inspect") {
      if (!running) return { stdout: JSON.stringify([{ State: { Running: false } }]) };
      return { stdout: JSON.stringify([{ State: { Running: true } }]) };
    }
    if (args[0] === "stop") { running = false; return { stdout: "" }; }
    throw new Error("unexpected command");
  };
  const runtime = new PodmanWorkloadRuntime({ runCommand, runtimeProbe: qualified });
  assert.equal((await runtime.stop(deploymentId)).result_code, "workload_stopped");
  assert.equal((await runtime.stop(deploymentId)).result_code, "workload_already_stopped");
});

test("restart rejects missing containers", async () => {
  let running = false;
  const runCommand = async (_command, args) => {
    if (args[0] === "inspect") {
      if (!running) { const error = new Error("missing"); error.stderr = "no such object"; throw error; }
      return { stdout: JSON.stringify([{ State: { Running: true } }]) };
    }
    if (args[0] === "restart") { running = true; return { stdout: "" }; }
    throw new Error("unexpected command");
  };
  const runtime = new PodmanWorkloadRuntime({ runCommand, runtimeProbe: qualified });
  await assert.rejects(runtime.restart(deploymentId, { container_port: 8080, health_check_path: "/", health_check_timeout_seconds: 5 }), /Podman workload operation failed/);
});

test("restart verifies the container and HTTP health after Podman restart", async () => {
  let running = true;
  const runCommand = async (_command, args) => {
    if (args[0] === "inspect") return { stdout: JSON.stringify([{ State: { Running: running }, NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49155" }] } } }]) };
    if (args[0] === "restart") { running = true; return { stdout: "" }; }
    throw new Error("unexpected command");
  };
  const runtime = new PodmanWorkloadRuntime({
    runCommand, runtimeProbe: qualified,
    fetchImpl: async (url) => { assert.equal(url, "http://127.0.0.1:49155/healthz"); return { status: 204 }; }
  });
  const result = await runtime.restart(deploymentId, { container_port: 8080, health_check_path: "/healthz", health_check_timeout_seconds: 5 });
  assert.equal(result.result_code, "workload_healthy");
});

test("deployment refuses unsigned images before Podman pulls or runs them", async () => {
  const calls = [];
  const runtime = new PodmanWorkloadRuntime({
    runtimeProbe: qualified,
    runCommand: async (binary, args) => {
      calls.push([binary, args]);
      if (binary === "cosign") { const error = new Error("no matching signatures"); error.stderr = "no matching signatures"; throw error; }
      if (args[0] === "inspect") { const error = new Error("missing container"); error.stderr = "no such object"; throw error; }
      throw new Error("Podman must not pull or run an unsigned image");
    }
  });
  await assert.rejects(runtime.deploy(payload), /OCI image signature verification failed/);
  assert.equal(calls.some(([binary, args]) => binary === "podman" && ["pull", "run"].includes(args[0])), false);
  assert.equal(calls.some(([binary]) => binary === "cosign"), true);
  assert.deepEqual(calls.find(([binary]) => binary === "cosign")[1], ["verify", "--key", "/etc/cloudexify/trust.pub", digest]);
});

test("deployment retries HTTP health checks and removes a container that never becomes healthy", async () => {
  const calls = [];
  let running = false;
  let clock = 0;
  const runtime = new PodmanWorkloadRuntime({
    runtimeProbe: qualified,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async () => ({ status: 503 }),
    runCommand: async (_binary, args) => {
      calls.push(args);
      if (args[0] === "verify") return { stdout: "verified" };
      if (args[0] === "inspect") {
        if (!running) { const error = new Error("missing"); error.stderr = "no such object"; throw error; }
        return { stdout: JSON.stringify([{ State: { Running: true }, NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] } } }]) };
      }
      if (args[0] === "run") { running = true; return { stdout: "container-id" }; }
      if (args[0] === "stop") { running = false; return { stdout: "" }; }
      if (args[0] === "rm") { running = false; return { stdout: "" }; }
      if (args[0] === "pull") return { stdout: "" };
      throw new Error("unexpected command " + args[0]);
    }
  });
  await assert.rejects(runtime.deploy({ ...payload, health_check_timeout_seconds: 5 }), /Application health check failed after 5 seconds/);
  assert.ok(calls.some((args) => args[0] === "stop"), "unhealthy container should be stopped");
  assert.ok(calls.some((args) => args[0] === "rm"), "unhealthy container should be removed");
});

test("deployment accepts a healthy application endpoint after initial connection failures", async () => {
  let running = false;
  let clock = 0;
  let probes = 0;
  const runtime = new PodmanWorkloadRuntime({
    runtimeProbe: qualified,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetchImpl: async () => { probes += 1; return probes < 3 ? { status: 503 } : { status: 204 }; },
    runCommand: async (_binary, args) => {
      if (args[0] === "verify" || args[0] === "pull" || args[0] === "run") { if (args[0] === "run") running = true; return { stdout: "" }; }
      if (args[0] === "inspect") {
        if (!running) { const error = new Error("missing"); error.stderr = "no such object"; throw error; }
        return { stdout: JSON.stringify([{ State: { Running: true }, NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49154" }] } } }]) };
      }
      throw new Error("unexpected command " + args[0]);
    }
  });
  const result = await runtime.deploy({ ...payload, health_check_path: "/healthz", health_check_timeout_seconds: 5 });
  assert.equal(result.result_code, "workload_healthy");
  assert.equal(probes, 3);
});

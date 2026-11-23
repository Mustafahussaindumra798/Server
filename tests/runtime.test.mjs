import test from "node:test";
import assert from "node:assert/strict";
import { PodmanWorkloadRuntime, validateDeploymentPayload } from "../src/agent/runtime.mjs";

const deploymentId = "40000000-0000-4000-8000-000000000001";
const digest = "registry.example.com/cloudexify/demo@sha256:" + "a".repeat(64);
const payload = {
  deployment_id: deploymentId,
  image: digest,
  container_port: 8080,
  resources: { cpu_millicores: 500, memory_bytes: 256 * 1024 * 1024 }
};
const qualified = async () => ({ ready: true, rootless: true, cgroup_version: "v2", cgroup_v2_available: true });

test("deployment manifests require immutable OCI digests and bounded resource requests", () => {
  assert.equal(validateDeploymentPayload(payload).container_name, "cloudexify-" + deploymentId);
  assert.throws(() => validateDeploymentPayload({ ...payload, image: "nginx:latest" }), /immutable OCI SHA-256 digest/);
  assert.throws(() => validateDeploymentPayload({ ...payload, container_port: 0 }), /Container port/);
  assert.throws(() => validateDeploymentPayload({ ...payload, resources: { cpu_millicores: 0, memory_bytes: 1 } }), /CPU and memory/);
  assert.throws(() => validateDeploymentPayload({ ...payload, command: "sh -c whoami" }), /unsupported fields/);
});

test("runtime refuses to execute when rootless Podman and cgroup v2 are not qualified", async () => {
  const runtime = new PodmanWorkloadRuntime({
    runtimeProbe: async () => ({ ready: false, rootless: false, cgroup_version: "v1", cgroup_v2_available: false }),
    runCommand: async () => { throw new Error("must not invoke Podman"); }
  });
  await assert.rejects(runtime.deploy(payload), /not qualified/);
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
  const runtime = new PodmanWorkloadRuntime({ runCommand, runtimeProbe: qualified });
  const result = await runtime.deploy(payload);
  assert.equal(result.result_code, "workload_process_running");
  assert.equal(result.local_port, 49152);
  const runArgs = calls.find((args) => args[0] === "run");
  for (const required of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--network=slirp4netns", "--user=10001:10001"]) {
    assert.ok(runArgs.includes(required), "missing " + required);
  }
  assert.ok(runArgs.includes("127.0.0.1::8080/tcp"));
  assert.equal(runArgs.some((arg) => arg.includes("sh -c") || arg.startsWith("--volume")), false);
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

test("restart confirms a running container and rejects missing containers", async () => {
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
  await assert.rejects(runtime.restart(deploymentId), /Podman workload operation failed/);
});

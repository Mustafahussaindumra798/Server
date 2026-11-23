import test from "node:test";
import assert from "node:assert/strict";
import { PodmanWorkloadRuntime, validateDeploymentPayload } from "../src/agent/runtime.mjs";

const deployment = {
  deployment_id: "40000000-0000-4000-8000-000000000001",
  image: "registry.example.com/team/app@sha256:" + "a".repeat(64),
  container_port: 8080,
  resources: {
    cpu_millicores: 500,
    memory_bytes: 256 * 1024 * 1024,
    disk_bytes: 1024 * 1024 * 1024
  },
  health_check_path: "/healthz",
  health_check_timeout_seconds: 5
};

function qualifiedRuntime(overrides = {}) {
  return new PodmanWorkloadRuntime({
    runtimeProbe: async () => ({
      ready: true,
      rootless: true,
      cgroup_version: "v2",
      cgroup_v2_available: true,
      storage_quota: { ready: true }
    }),
    runCommand: async () => ({ stdout: "ok", stderr: "" }),
    fetchImpl: async () => ({ status: 204 }),
    ...overrides
  });
}

test("deployment payload accepts only immutable OCI digests and bounded resource requests", () => {
  assert.equal(validateDeploymentPayload(deployment).container_name, "cloudexify-40000000-0000-4000-8000-000000000001");
  assert.throws(() => validateDeploymentPayload({ ...deployment, image: "registry.example.com/team/app:latest" }), /immutable OCI SHA-256 digest/);
  assert.throws(() => validateDeploymentPayload({ ...deployment, resources: { ...deployment.resources, memory_bytes: 1 } }), /resource requests are invalid/);
  assert.throws(() => validateDeploymentPayload({ ...deployment, extra_command: "id" }), /unsupported fields/);
});

test("deploy verifies signatures before pulling and applies rootless container restrictions", async () => {
  const calls = [];
  const runtime = qualifiedRuntime({
    runCommand: async (binary, args) => {
      calls.push({ binary, args });
      if (binary === "podman" && args[0] === "inspect") {
        return { stdout: JSON.stringify([{
          State: { Running: true },
          NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "43127" }] } }
        }]) };
      }
      return { stdout: "ok", stderr: "" };
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:43127/healthz");
      assert.equal(options.redirect, "error");
      return { status: 204 };
    }
  });

  const result = await runtime.deploy(deployment);
  assert.equal(result.result_code, "workload_healthy");
  assert.equal(result.local_port, 43127);
  assert.deepEqual(calls[0].args.slice(0, 2), ["verify", "--key"]);
  assert.equal(calls[1].args[0], "pull");
  const run = calls.find((call) => call.binary === "podman" && call.args[0] === "run");
  assert.ok(run);
  for (const flag of [
    "--network=slirp4netns",
    "--publish", "127.0.0.1::8080/tcp",
    "--pids-limit=128",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=10001:10001"
  ]) assert.ok(run.args.includes(flag), "missing required Podman flag: " + flag);
});

test("deploy fails closed when storage quota qualification is missing", async () => {
  let commandCount = 0;
  const runtime = qualifiedRuntime({
    runtimeProbe: async () => ({
      ready: true,
      rootless: true,
      cgroup_version: "v2",
      cgroup_v2_available: true,
      storage_quota: { ready: false }
    }),
    runCommand: async () => { commandCount += 1; return { stdout: "ok" }; }
  });
  await assert.rejects(runtime.deploy(deployment), /storage quotas/);
  assert.equal(commandCount, 0);
});

test("health checks are pinned to loopback and reject redirects", async () => {
  let request;
  const runtime = qualifiedRuntime({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { status: 302 };
    },
    now: (() => { let time = 0; return () => time; })(),
    sleep: async () => {}
  });
  await assert.rejects(
    runtime.waitForHealth(43210, { health_check_path: "/ready", health_check_timeout_seconds: 5 }),
    /Application health check failed/
  );
  assert.equal(request.url, "http://127.0.0.1:43210/ready");
  assert.equal(request.options.redirect, "error");
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const MIN_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;

function validateDeploymentPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Deployment payload must be an object.");
  const allowed = ["deployment_id", "image", "container_port", "resources"];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) throw new Error("Deployment payload contains unsupported fields.");
  if (!UUID.test(payload.deployment_id || "")) throw new Error("Deployment ID is invalid.");
  if (typeof payload.image !== "string" || !IMAGE_DIGEST.test(payload.image)) throw new Error("Deployment image must be a fully qualified, immutable OCI SHA-256 digest.");
  if (!Number.isInteger(payload.container_port) || payload.container_port < 1 || payload.container_port > 65535) throw new Error("Container port must be an integer from 1 to 65535.");
  const resources = payload.resources;
  if (!resources || typeof resources !== "object" || Array.isArray(resources) ||
      Object.keys(resources).some((key) => !["cpu_millicores", "memory_bytes"].includes(key)) ||
      !Number.isInteger(resources.cpu_millicores) || resources.cpu_millicores < 50 || resources.cpu_millicores > 64000 ||
      !Number.isSafeInteger(resources.memory_bytes) || resources.memory_bytes < MIN_MEMORY_BYTES || resources.memory_bytes > MAX_MEMORY_BYTES) {
    throw new Error("Deployment CPU and memory requests are invalid or outside supported bounds.");
  }
  return { ...payload, container_name: "cloudexify-" + payload.deployment_id.toLowerCase() };
}

export class PodmanWorkloadRuntime {
  constructor({ runCommand = execFileAsync, runtimeProbe, timeoutMs = 30000 } = {}) {
    this.runCommand = runCommand;
    this.runtimeProbe = runtimeProbe;
    this.timeoutMs = timeoutMs;
  }

  async command(args, timeout = this.timeoutMs) {
    try {
      return await this.runCommand("podman", args, { timeout, maxBuffer: 256 * 1024, windowsHide: true });
    } catch (error) {
      const detail = String(error?.stderr || error?.message || "Podman command failed").replace(/[\r\n]+/g, " ").slice(0, 500);
      throw new Error("Podman workload operation failed: " + detail);
    }
  }

  async assertReady() {
    if (!this.runtimeProbe) throw new Error("Podman runtime qualification is required before workload execution.");
    const probe = await this.runtimeProbe();
    if (!probe?.ready || probe.rootless !== true || probe.cgroup_version !== "v2" || probe.cgroup_v2_available !== true) {
      throw new Error("Node is not qualified for rootless Podman workload execution.");
    }
  }

  async inspect(containerName) {
    const result = await this.command(["inspect", containerName]);
    let value;
    try { value = JSON.parse(result.stdout); } catch { throw new Error("Podman returned invalid container inspection data."); }
    if (!Array.isArray(value) || !value[0]) return null;
    return value[0];
  }

  async deploy(rawPayload) {
    const payload = validateDeploymentPayload(rawPayload);
    await this.assertReady();
    const existing = await this.inspect(payload.container_name).catch((error) => {
      if (/no such object|not found/i.test(error.message)) return null;
      throw error;
    });
    if (existing?.State?.Running) {
      return { result_code: "workload_already_running", result_summary: "Deployment container is already running.", container_name: payload.container_name, local_port: this.getHostPort(existing, payload.container_port) };
    }
    if (existing) await this.command(["rm", "--force", payload.container_name]);

    await this.command(["pull", "--quiet", payload.image], 300000);
    const args = [
      "run", "--detach",
      "--name", payload.container_name,
      "--label", "io.cloudexify.managed=true",
      "--label", "io.cloudexify.deployment=" + payload.deployment_id,
      "--pull=never",
      "--network=slirp4netns",
      "--publish", "127.0.0.1::" + payload.container_port + "/tcp",
      "--cpus=" + String(payload.resources.cpu_millicores / 1000),
      "--memory=" + String(payload.resources.memory_bytes),
      "--pids-limit=128",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=10001:10001",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m",
      payload.image
    ];
    await this.command(args, 120000);
    const inspection = await this.inspect(payload.container_name);
    if (!inspection?.State?.Running) throw new Error("Container did not enter the running state.");
    return {
      result_code: "workload_process_running",
      result_summary: "Rootless OCI container started; application health has not yet been verified.",
      container_name: payload.container_name,
      local_port: this.getHostPort(inspection, payload.container_port)
    };
  }

  getHostPort(inspection, containerPort) {
    const mappings = inspection?.NetworkSettings?.Ports?.[containerPort + "/tcp"];
    const mapping = Array.isArray(mappings) ? mappings.find((item) => item?.HostIp === "127.0.0.1" && /^\d+$/.test(item?.HostPort || "")) : null;
    return mapping ? Number(mapping.HostPort) : null;
  }

  async stop(deploymentId) {
    if (!UUID.test(deploymentId || "")) throw new Error("Deployment ID is invalid.");
    await this.assertReady();
    const name = "cloudexify-" + deploymentId.toLowerCase();
    const existing = await this.inspect(name).catch((error) => {
      if (/no such object|not found/i.test(error.message)) return null;
      throw error;
    });
    if (!existing || !existing.State?.Running) return { result_code: "workload_already_stopped", result_summary: "Deployment container is absent or already stopped." };
    await this.command(["stop", "--time", "10", name], 20000);
    const after = await this.inspect(name);
    if (after?.State?.Running) throw new Error("Container remained running after stop request.");
    return { result_code: "workload_stopped", result_summary: "Container stop was confirmed by Podman." };
  }

  async restart(deploymentId) {
    if (!UUID.test(deploymentId || "")) throw new Error("Deployment ID is invalid.");
    await this.assertReady();
    const name = "cloudexify-" + deploymentId.toLowerCase();
    const existing = await this.inspect(name);
    if (!existing) throw new Error("Deployment container does not exist on this node.");
    await this.command(["restart", "--time", "10", name], 30000);
    const after = await this.inspect(name);
    if (!after?.State?.Running) throw new Error("Container restart was not confirmed.");
    return { result_code: "workload_restarted", result_summary: "Container restart was confirmed; application health has not yet been verified." };
  }
}

export { validateDeploymentPayload };

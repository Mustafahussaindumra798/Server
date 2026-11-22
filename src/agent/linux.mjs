import os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import path from "node:path";

const ARCHITECTURES = new Map([["x64", "x86_64"], ["arm64", "aarch64"]]);

export function getLinuxIdentity(platform = process.platform, architecture = process.arch) {
  if (platform !== "linux") throw new Error("Cloudexify Linux agent requires a Linux host.");
  const normalized = ARCHITECTURES.get(architecture);
  if (!normalized) throw new Error("Unsupported Linux architecture: " + architecture + ". Supported: x86_64 and aarch64.");
  return { platform: "linux", architecture: normalized };
}

export function getCapabilities() {
  return {
    agent_protocol: 1,
    diagnostics: ["probe", "collect_metrics"],
    service_manager: "systemd",
    container_runtime: null,
    workload_execution: false
  };
}

async function readCpuCounters(procRoot) {
  const contents = await readFile(path.join(procRoot, "stat"), "utf8");
  const line = contents.split("\n").find((item) => item.startsWith("cpu "));
  if (!line) throw new Error("CPU counters are unavailable.");
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("CPU counters are invalid.");
  const idle = values[3] + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { idle, total };
}

export async function readCpuPercent({ procRoot = "/proc", delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const before = await readCpuCounters(procRoot);
  await delay(120);
  const after = await readCpuCounters(procRoot);
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return Math.round(Math.max(0, Math.min(100, (1 - idle / total) * 100)) * 10) / 10;
}

export async function readLinuxMetrics({ procRoot = "/proc", diskPath = "/" } = {}) {
  const metrics = { uptime_seconds: Math.max(0, Math.floor(os.uptime())) };
  try {
    const meminfo = await readFile(path.join(procRoot, "meminfo"), "utf8");
    const values = Object.fromEntries(meminfo.split("\n").map((line) => {
      const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
      return match ? [match[1], Number(match[2]) * 1024] : null;
    }).filter(Boolean));
    if (Number.isFinite(values.MemTotal) && values.MemTotal > 0) {
      metrics.memory_total_bytes = values.MemTotal;
      const available = Number.isFinite(values.MemAvailable) ? values.MemAvailable : values.MemFree;
      if (Number.isFinite(available) && available >= 0 && available <= values.MemTotal) {
        metrics.memory_used_bytes = values.MemTotal - available;
      }
    }
  } catch { /* unavailable metrics are omitted, never fabricated */ }
  try {
    const disk = await statfs(diskPath);
    const total = Number(disk.blocks) * Number(disk.bsize);
    const available = Number(disk.bavail) * Number(disk.bsize);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(available) && available >= 0 && available <= total) {
      metrics.disk_total_bytes = total;
      metrics.disk_available_bytes = available;
    }
  } catch { /* unavailable metrics are omitted */ }
  const load = os.loadavg()[0];
  if (Number.isFinite(load) && load >= 0) metrics.load_1m = Math.round(load * 100) / 100;
  try {
    const cpu = await readCpuPercent({ procRoot });
    if (cpu !== null) metrics.cpu_percent = cpu;
  } catch { /* CPU counters may be unavailable in restricted containers */ }
  return metrics;
}

export function validateControlPlaneUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("CLOUDEXIFY_CONTROL_PLANE_URL must be a valid absolute URL."); }
  const localHost = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    throw new Error("Control-plane URL must use HTTPS (HTTP is allowed only for localhost testing).");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("Control-plane URL must not contain credentials, query parameters or fragments.");
  return url.toString().replace(/\/$/, "");
}

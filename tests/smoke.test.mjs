import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = 43000 + (process.pid % 10000);
const origin = `http://127.0.0.1:${port}`;
let server;

before(async () => {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "ignore"
  });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.equal(ready, true, "development server should start");
});

after(() => {
  if (server && !server.killed) server.kill("SIGTERM");
});

test("health endpoint reports simulation mode", async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok", mode: "simulation", service: "cloudexify-dashboard"
  });
});

test("serves dashboard and static assets", async () => {
  for (const [route, type] of [
    ["/", "text/html"],
    ["/styles.css", "text/css"],
    ["/app.js", "text/javascript"]
  ]) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type") || "", new RegExp(type));
    assert.ok((await response.text()).length > 0, route);
  }
});

test("returns 404 for missing files", async () => {
  const response = await fetch(`${origin}/not-a-real-file`);
  assert.equal(response.status, 404);
});

test("blocks decoded path traversal", async () => {
  const response = await fetch(`${origin}/..%2f..%2fetc%2fpasswd`);
  assert.equal(response.status, 403);
});

test("rejects unsupported methods", async () => {
  const response = await fetch(origin, { method: "POST" });
  assert.equal(response.status, 405);
});

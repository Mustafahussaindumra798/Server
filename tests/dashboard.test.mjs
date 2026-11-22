import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("dashboard uses Supabase Auth and the protected control-plane API", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /token\?grant_type=password/);
  assert.match(app, /\/api\/v1\/auth\/me/);
  assert.match(app, /\/api\/v1\/tenants/);
  assert.match(html, /id="login-form"/);
  assert.match(html, /LIVE DATA/);
});

test("dashboard has no simulated inventory or sample infrastructure", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(app, /android-node-01|Cloudexify Website|Sample devices|SIMULATED/);
  assert.doesNotMatch(html, /SIMULATED|sample data/i);
});

test("dashboard escapes database values before rendering HTML", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /export const escapeHtml/);
  assert.match(app, /escapeHtml\(node\.name\)/);
});


test("dashboard uses a three-second refresh and a single snapshot request", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /REFRESH_INTERVAL_MS = 3000/);
  assert.match(app, /api\(base \+ "\/overview"\)/);
  assert.doesNotMatch(app, /api\(base \+ "\/nodes"\), api\(base \+ "\/applications"\)/);
});


test("dashboard refreshes Supabase sessions before expiry and retries stale access tokens once", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /SESSION_REFRESH_MARGIN_SECONDS = 300/);
  assert.match(app, /ensureFreshSession\(\{ force: true \}\)/);
  assert.match(app, /Preserve a valid refresh token during transient Auth\/network failures/);
  assert.match(app, /response\.status === 401/);
});

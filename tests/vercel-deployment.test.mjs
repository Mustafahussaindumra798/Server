import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDatabasePool } from "../src/db/pool.mjs";

test("Vercel configuration serves root static assets and Node API functions", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.framework, null);
  assert.equal(config.functions["api/**/*.mjs"].maxDuration, 30);
  const versionedApi = await readFile(new URL("../api/v1/[...path].mjs", import.meta.url), "utf8");
  assert.match(versionedApi, /createApiHandler/);
  assert.match(versionedApi, /createDatabasePool/);
});

test("serverless database pool can be limited to one connection", async () => {
  const pool = createDatabasePool("postgresql://test:test@127.0.0.1:5432/test", { max: 1 });
  assert.equal(pool.options.max, 1);
  await pool.end();
});

test("database pool rejects unsafe or invalid pool sizes", () => {
  assert.throws(
    () => createDatabasePool("postgresql://test:test@127.0.0.1:5432/test", { max: 0 }),
    /between 1 and 10/
  );
  assert.throws(
    () => createDatabasePool("postgresql://test:test@127.0.0.1:5432/test", { max: 11 }),
    /between 1 and 10/
  );
});

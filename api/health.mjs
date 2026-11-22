import { createDatabasePool } from "../src/db/pool.mjs";

const pool = process.env.DATABASE_URL ? createDatabasePool(process.env.DATABASE_URL, {
  max: process.env.DB_POOL_MAX ? Number(process.env.DB_POOL_MAX) : 1
}) : null;

export default async function handler(_request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");

  if (!pool) {
    response.statusCode = 503;
    response.end(JSON.stringify({ status: "not_configured", service: "cloudexify-control-plane", database: "not_configured" }));
    return;
  }

  try {
    await pool.query("SELECT 1");
    response.statusCode = 200;
    response.end(JSON.stringify({ status: "ok", service: "cloudexify-control-plane", database: "connected" }));
  } catch {
    response.statusCode = 503;
    response.end(JSON.stringify({ status: "degraded", service: "cloudexify-control-plane", database: "unavailable" }));
  }
}

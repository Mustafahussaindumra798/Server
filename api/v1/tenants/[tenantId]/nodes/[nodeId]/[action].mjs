import { createApiHandler } from "../../../../../../src/api.mjs";
import { createDatabasePool } from "../../../../../../src/db/pool.mjs";

// Explicit Vercel route for tenant-scoped node approval/rejection actions.
// The shared API handler validates the tenant membership, role and node state.
const pool = process.env.DATABASE_URL ? createDatabasePool(process.env.DATABASE_URL, {
  max: process.env.DB_POOL_MAX ? Number(process.env.DB_POOL_MAX) : 1
}) : null;

const handleApi = createApiHandler({ pool });

export default async function handler(request, response) {
  const handled = await handleApi(request, response);
  if (!handled && !response.writableEnded) {
    response.statusCode = 404;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "API route not found." } }));
  }
}

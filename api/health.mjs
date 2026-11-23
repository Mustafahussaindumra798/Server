import { createDatabasePool } from "../src/db/pool.mjs";

const pool = process.env.DATABASE_URL ? createDatabasePool(process.env.DATABASE_URL, {
  max: process.env.DB_POOL_MAX ? Number(process.env.DB_POOL_MAX) : 1
}) : null;

export function createHealthHandler(databasePool) {
  return async function handler(_request, response) {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");

    if (!databasePool) {
      response.statusCode = 503;
      response.end(JSON.stringify({ status: "not_configured", service: "cloudexify-control-plane", database: "not_configured" }));
      return;
    }

    try {
      const result = await databasePool.query(`
        SELECT
          to_regclass('public.applications') IS NOT NULL AS applications_table,
          to_regclass('public.deployments') IS NOT NULL AS deployments_table,
          to_regclass('public.nodes') IS NOT NULL AS nodes_table,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'applications'
              AND column_name = 'resource_requests_json'
          ) AS application_resource_requests,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'deployments'
              AND column_name = 'resource_requests_json'
          ) AS deployment_resource_requests,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'nodes'
              AND column_name = 'resource_metrics_json'
          ) AS node_resource_metrics,
          to_regprocedure('app_private.accept_node_heartbeat(uuid,text,text,text,jsonb)') IS NOT NULL AS heartbeat_function,
          to_regprocedure('app_private.claim_node_jobs(uuid,text,integer,integer)') IS NOT NULL AS claim_jobs_function,
          to_regprocedure('app_private.acknowledge_node_job(uuid,text,uuid,uuid,uuid,text,text,text)') IS NOT NULL AS acknowledge_job_function
      `);
      const schema = result.rows[0] || {};
      const baseReady = schema.applications_table && schema.deployments_table && schema.nodes_table &&
        schema.node_resource_metrics && schema.heartbeat_function && schema.claim_jobs_function &&
        schema.acknowledge_job_function;
      const resourceAdmissionReady = schema.application_resource_requests && schema.deployment_resource_requests;

      if (!baseReady || !resourceAdmissionReady) {
        response.statusCode = 503;
        response.end(JSON.stringify({
          status: "migration_required",
          service: "cloudexify-control-plane",
          database: "connected",
          schema: baseReady ? "partial" : "incomplete",
          pending_migrations: resourceAdmissionReady ? [] : ["007_resource_admission"]
        }));
        return;
      }

      response.statusCode = 200;
      response.end(JSON.stringify({
        status: "ok",
        service: "cloudexify-control-plane",
        database: "connected",
        schema: "ready",
        resource_admission: "ready"
      }));
    } catch {
      response.statusCode = 503;
      response.end(JSON.stringify({ status: "degraded", service: "cloudexify-control-plane", database: "unavailable" }));
    }
  };
}

export default createHealthHandler(pool);

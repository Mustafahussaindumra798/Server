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
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'deployments'
              AND column_name = 'image_digest'
          ) AS deployment_image_digest,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'deployments'
              AND column_name = 'container_port'
          ) AS deployment_container_port,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'deployments'
              AND column_name = 'health_check_path'
          ) AS deployment_health_check_path,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'deployments'
              AND column_name = 'health_check_timeout_seconds'
          ) AS deployment_health_check_timeout,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'deployments'
              AND column_name = 'health_checked_at'
          ) AS deployment_health_checked_at,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'deployments'
              AND column_name = 'rollback_attempt_for_deployment_id'
          ) AS deployment_automatic_rollback,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'deployments'
              AND column_name = 'runtime_local_port'
          ) AS deployment_runtime_local_port,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'job_attempts'
              AND column_name = 'result_json'
          ) AS job_attempt_result_json,
          EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = to_regclass('public.job_attempts')
              AND tgname = 'job_attempts_record_deployment_endpoint'
              AND NOT tgisinternal
          ) AS deployment_endpoint_registration,
          COALESCE(position('deployment.rollback.queued' in pg_get_functiondef(to_regprocedure('app_private.reconcile_deployment_job_status()'))) > 0, false) AS deployment_rollback_reconciliation,
          COALESCE(position('workload_healthy' in pg_get_functiondef(to_regprocedure('app_private.reconcile_deployment_job_status()'))) > 0, false) AS deployment_health_reconciliation,
          COALESCE(position('workload_stopped' in pg_get_functiondef(to_regprocedure('app_private.reconcile_deployment_job_status()'))) > 0, false) AS deployment_stop_reconciliation,
          COALESCE(position('restarting' in pg_get_functiondef(to_regprocedure('app_private.reconcile_deployment_job_status()'))) > 0, false) AS deployment_restart_reconciliation,
          EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = to_regclass('public.jobs')
              AND tgname = 'jobs_reconcile_deployment_status'
              AND NOT tgisinternal
          ) AS deployment_job_reconciliation,
          EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgrelid = to_regclass('public.deployments')
              AND tgname = 'deployments_cancel_queued_jobs'
              AND NOT tgisinternal
          ) AS deployment_job_cancellation,
          to_regprocedure('app_private.accept_node_heartbeat(uuid,text,text,text,jsonb)') IS NOT NULL AS heartbeat_function,
          to_regprocedure('app_private.accept_node_heartbeat(uuid,text,text,text,jsonb,jsonb)') IS NOT NULL AS capability_heartbeat_function,
          to_regprocedure('app_private.claim_node_jobs(uuid,text,integer,integer)') IS NOT NULL AS claim_jobs_function,
          to_regprocedure('app_private.acknowledge_node_job(uuid,text,uuid,uuid,uuid,text,text,text,jsonb)') IS NOT NULL AS acknowledge_job_function,
          to_regprocedure('app_private.reconcile_node_deployments(uuid)') IS NOT NULL AS runtime_reconciliation_function
      `);
      const schema = result.rows[0] || {};
      const baseReady = schema.applications_table && schema.deployments_table && schema.nodes_table &&
        schema.node_resource_metrics && schema.heartbeat_function && schema.claim_jobs_function &&
        schema.acknowledge_job_function;
      const resourceAdmissionReady = schema.application_resource_requests && schema.deployment_resource_requests;
      const runtimeCapabilitiesReady = schema.capability_heartbeat_function;
      const deploymentOrchestrationReady = schema.deployment_image_digest && schema.deployment_container_port && schema.deployment_job_reconciliation && schema.deployment_job_cancellation;
      const deploymentHealthReady = schema.deployment_health_check_path && schema.deployment_health_check_timeout && schema.deployment_health_checked_at && schema.deployment_health_reconciliation;
      const deploymentLifecycleReady = schema.deployment_stop_reconciliation && schema.deployment_restart_reconciliation;
      const runtimeReconciliationReady = schema.runtime_reconciliation_function;
      const deploymentRollbackReady = schema.deployment_automatic_rollback && schema.deployment_rollback_reconciliation;
      const deploymentEndpointReady = schema.deployment_runtime_local_port && schema.job_attempt_result_json && schema.deployment_endpoint_registration;

      if (!baseReady || !resourceAdmissionReady || !runtimeCapabilitiesReady || !deploymentOrchestrationReady || !deploymentHealthReady || !deploymentLifecycleReady || !runtimeReconciliationReady || !deploymentRollbackReady || !deploymentEndpointReady) {
        response.statusCode = 503;
        response.end(JSON.stringify({
          status: "migration_required",
          service: "cloudexify-control-plane",
          database: "connected",
          schema: baseReady ? "partial" : "incomplete",
          pending_migrations: [
            ...(!resourceAdmissionReady ? ["007_resource_admission"] : []),
            ...(!runtimeCapabilitiesReady ? ["008_runtime_capability_heartbeat"] : []),
            ...(!deploymentOrchestrationReady ? ["009_deployment_job_orchestration"] : []),
            ...(!deploymentHealthReady ? ["010_deployment_health_checks"] : []),
            ...(!deploymentLifecycleReady ? ["011_deployment_lifecycle_jobs"] : []),
            ...(!runtimeReconciliationReady ? ["012_durable_runtime_reconciliation"] : []),
            ...(!deploymentRollbackReady ? ["013_automatic_deployment_rollback"] : []),
            ...(!deploymentEndpointReady ? ["014_runtime_endpoint_registration"] : [])
          ]
        }));
        return;
      }

      response.statusCode = 200;
      response.end(JSON.stringify({
        status: "ok",
        service: "cloudexify-control-plane",
        database: "connected",
        schema: "ready",
        resource_admission: "ready",
        runtime_capabilities: "ready",
        deployment_job_orchestration: "ready",
        deployment_health_checks: "ready",
        deployment_lifecycle_jobs: "ready",
        durable_runtime_reconciliation: "ready",
        automatic_deployment_rollback: "ready",
        runtime_endpoint_registration: "ready"
      }));
    } catch {
      response.statusCode = 503;
      response.end(JSON.stringify({ status: "degraded", service: "cloudexify-control-plane", database: "unavailable" }));
    }
  };
}

export default createHealthHandler(pool);

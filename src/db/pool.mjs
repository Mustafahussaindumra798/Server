import { Pool } from "pg";

export function createDatabasePool(connectionString, { max = process.env.VERCEL ? 1 : 10, queryTimeoutMillis = 0 } = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  if (!Number.isInteger(max) || max < 1 || max > 10) {
    throw new Error("Database pool max must be an integer between 1 and 10.");
  }
  if (!Number.isInteger(queryTimeoutMillis) || queryTimeoutMillis < 0 || queryTimeoutMillis > 30000) {
    throw new Error("Database query timeout must be between 0 and 30000 milliseconds.");
  }
  return new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    ...(queryTimeoutMillis ? { query_timeout: queryTimeoutMillis } : {}),
    application_name: "cloudexify-control-plane"
  });
}

export async function withUserTransaction(pool, identitySubject, callback) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT set_config('app.identity_subject', $1, true)", [identitySubject]);
    const identity = await client.query(
      "SELECT id, identity_subject, email, display_name FROM users WHERE identity_subject = $1 LIMIT 1",
      [identitySubject]
    );
    const user = identity.rows[0];
    if (!user) {
      const error = new Error("This identity is not provisioned for Cloudexify.");
      error.status = 403;
      error.code = "IDENTITY_NOT_PROVISIONED";
      throw error;
    }
    await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
    await client.query("SELECT set_config('app.identity_subject', '', true)");
    const result = await callback(client, user);
    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}


export async function withNodeEnrollment(pool, enrollment) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await client.query("SELECT * FROM app_private.enroll_node($1, $2, $3, $4, $5, $6::jsonb, $7)", [
      enrollment.tokenHash, enrollment.name, enrollment.platform, enrollment.architecture,
      enrollment.agentVersion, JSON.stringify(enrollment.capabilities), enrollment.credentialHash
    ]);
    await client.query("COMMIT");
    transactionStarted = false;
    return result.rows[0] || null;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}


export async function withNodeHeartbeat(pool, heartbeat) {
  const client = await pool.connect(); let transactionStarted = false;
  try {
    await client.query("BEGIN"); transactionStarted = true;
    const result = await client.query("SELECT * FROM app_private.accept_node_heartbeat($1, $2, $3, $4, $5::jsonb, $6::jsonb)", [heartbeat.nodeId, heartbeat.credentialHash, heartbeat.agentVersion, heartbeat.healthStatus, JSON.stringify(heartbeat.resources), JSON.stringify(heartbeat.capabilities)]);
    await client.query("COMMIT"); transactionStarted = false; return result.rows[0] || null;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}


export async function withNodeJobClaim(pool, claim) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const credential = await client.query(
      "SELECT app_private.node_credential_is_valid($1, $2) AS valid",
      [claim.nodeId, claim.credentialHash]
    );
    if (!credential.rows[0]?.valid) {
      await client.query("COMMIT");
      transactionStarted = false;
      return null;
    }
    const result = await client.query(
      "SELECT * FROM app_private.claim_node_jobs($1, $2, $3, $4)",
      [claim.nodeId, claim.credentialHash, claim.limit, claim.leaseSeconds]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return result.rows;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function withNodeJobAcknowledgement(pool, acknowledgement) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await client.query(
      "SELECT * FROM app_private.acknowledge_node_job($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        acknowledgement.nodeId, acknowledgement.credentialHash,
        acknowledgement.jobId, acknowledgement.attemptId,
        acknowledgement.leaseToken, acknowledgement.status,
        acknowledgement.resultCode, acknowledgement.resultSummary,
        JSON.stringify(acknowledgement.resultMetadata || {})
      ]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return result.rows[0] || null;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}


export async function withNodeRouteAuthorization(pool, authorization) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const credential = await client.query(
      "SELECT app_private.node_credential_is_valid($1, $2) AS valid",
      [authorization.nodeId, authorization.credentialHash]
    );
    if (!credential.rows[0]?.valid) {
      await client.query("COMMIT");
      transactionStarted = false;
      return null;
    }
    const result = await client.query(`
      SELECT route.id AS route_id, route.route_version, route.tenant_id,
             claim.hostname, deployment.id AS deployment_id,
             route.node_id, deployment.runtime_local_port AS local_port
        FROM public.deployment_domain_routes AS route
        JOIN public.domain_claims AS claim
          ON claim.id = route.domain_claim_id AND claim.tenant_id = route.tenant_id
        JOIN public.tenants AS tenant ON tenant.id = route.tenant_id
        JOIN public.applications AS application
          ON application.id = route.application_id AND application.tenant_id = route.tenant_id
        JOIN public.deployments AS deployment
          ON deployment.id = route.deployment_id
         AND deployment.application_id = route.application_id
         AND deployment.tenant_id = route.tenant_id
        JOIN public.nodes AS node
          ON node.id = route.node_id AND node.tenant_id = route.tenant_id
       WHERE route.id = $1
         AND route.node_id = $2
         AND route.status = 'active'
         AND route.reason_code = 'transport_ready'
         AND node.capabilities_json->>'ingress_tunnel' = 'true'
         AND node.capabilities_json->>'loopback_forwarder' = 'true'
         AND claim.status = 'verified'
         AND tenant.status = 'active'
         AND application.desired_state = 'running'
         AND deployment.desired_state = 'running'
         AND deployment.status = 'healthy'
         AND deployment.target_node_id = node.id
         AND deployment.runtime_local_port BETWEEN 1 AND 65535
         AND deployment.runtime_observed_at > clock_timestamp() - interval '5 minutes'
         AND node.platform = 'linux'
         AND node.approved_at IS NOT NULL
         AND node.status = 'online'
         AND node.last_seen_at > clock_timestamp() -
             make_interval(secs => node.heartbeat_interval_seconds * 3)
       FOR SHARE OF route, deployment, node
    `, [authorization.routeId, authorization.nodeId]);
    await client.query("COMMIT");
    transactionStarted = false;
    return result.rows[0] || false;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function withNodeRuntimeReconciliation(pool, reconciliation) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const credential = await client.query(
      "SELECT app_private.node_credential_is_valid($1, $2) AS valid",
      [reconciliation.nodeId, reconciliation.credentialHash]
    );
    if (!credential.rows[0]?.valid) {
      await client.query("COMMIT");
      transactionStarted = false;
      return null;
    }
    const result = await client.query(
      "SELECT app_private.reconcile_node_deployments($1) AS reconciled_jobs",
      [reconciliation.nodeId]
    );
    await client.query("COMMIT");
    transactionStarted = false;
    return Number(result.rows[0]?.reconciled_jobs || 0);
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

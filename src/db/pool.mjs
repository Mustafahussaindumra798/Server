import { Pool } from "pg";

export function createDatabasePool(connectionString, { max = process.env.VERCEL ? 1 : 10 } = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  if (!Number.isInteger(max) || max < 1 || max > 10) {
    throw new Error("Database pool max must be an integer between 1 and 10.");
  }
  return new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
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

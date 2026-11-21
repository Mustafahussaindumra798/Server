import { Pool } from "pg";

export function createDatabasePool(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  return new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
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

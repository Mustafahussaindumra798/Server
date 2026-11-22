import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createOidcVerifier, getBearerToken } from "./auth/oidc.mjs";
import { createSupabaseAuthVerifier } from "./auth/supabase.mjs";
import { AuthorizationError, requirePermission, canAssignRole } from "./auth/rbac.mjs";
import { withNodeEnrollment, withNodeHeartbeat, withNodeJobAcknowledgement, withNodeJobClaim, withUserTransaction } from "./db/pool.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;

function send(response, status, payload, requestId, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { const error = new Error("Request body must be valid JSON."); error.status = 400; throw error; }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    const error = new Error("Request body must be a JSON object.");
    error.status = 400;
    throw error;
  }
  return value;
}

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) {
    const error = new Error(field + " must be a valid UUID.");
    error.status = 400;
    throw error;
  }
  return value;
}

function requireText(value, field, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    const error = new Error(field + " is required and must be at most " + max + " characters.");
    error.status = 400;
    throw error;
  }
  return value.trim();
}

function audit(client, tenantId, userId, action, resourceType, resourceId, metadata = {}) {
  return client.query(
    "INSERT INTO audit_events (tenant_id, actor_type, actor_id, action, resource_type, resource_id, metadata_json) VALUES ($1, 'user', $2, $3, $4, $5, $6::jsonb)",
    [tenantId, userId, action, resourceType, resourceId, JSON.stringify(metadata)]
  );
}

async function getMembership(client, tenantId, userId) {
  const result = await client.query(
    "SELECT membership.role, tenant.status AS tenant_status FROM tenant_memberships AS membership JOIN tenants AS tenant ON tenant.id = membership.tenant_id WHERE membership.tenant_id = $1 AND membership.user_id = $2 AND membership.status = 'active' AND tenant.status = 'active' LIMIT 1",
    [tenantId, userId]
  );
  if (!result.rows[0]) {
    const error = new Error("Tenant not found.");
    error.status = 404;
    throw error;
  }
  return result.rows[0].role;
}


function validateJobPayload(type, payload) {
  // Only non-mutating, structured diagnostics are enabled in this protocol
  // version. Never accept shell text, executable paths, scripts or argv arrays.
  if (!["probe", "collect_metrics"].includes(type)) {
    const error = new Error("type must be probe or collect_metrics.");
    error.status = 400;
    throw error;
  }
  if (!payload || Array.isArray(payload) || typeof payload !== "object" || Object.keys(payload).length !== 0) {
    const error = new Error("payload must be an empty JSON object for this job type.");
    error.status = 400;
    throw error;
  }
  return {};
}

function nodeCredential(request) {
  return String(request.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1] || null;
}

export function createApiHandler({ pool, env = process.env, fetchImpl = fetch, logger = console }) {
  let verifyAccessToken;
  try {
    const supabaseApiKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
    if (env.SUPABASE_URL && supabaseApiKey) {
      verifyAccessToken = createSupabaseAuthVerifier({ supabaseUrl: env.SUPABASE_URL, apiKey: supabaseApiKey, fetchImpl });
    } else {
      verifyAccessToken = createOidcVerifier({
        issuer: env.OIDC_ISSUER,
        audience: env.OIDC_AUDIENCE,
        jwksUri: env.OIDC_JWKS_URI,
        fetchImpl
      });
    }
  } catch {
    verifyAccessToken = null;
  }
  const allowedOrigins = new Set(String(env.CORS_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));

  return async function handleApi(request, response) {
    const url = new URL(request.url || "/", "http://localhost");
    if (!url.pathname.startsWith("/api/v1/")) return false;
    const requestId = randomUUID();
    const origin = request.headers.origin;
    if (origin) {
      if (!allowedOrigins.has(origin)) {
        send(response, 403, { error: { code: "ORIGIN_NOT_ALLOWED", message: "Origin is not allowed.", request_id: requestId } }, requestId);
        return true;
      }
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, X-Request-ID",
        "access-control-max-age": "600",
        "vary": "Origin"
      });
      response.end();
      return true;
    }

    try {
      if (!["GET", "POST"].includes(request.method || "")) {
        const error = new Error("Method not allowed.");
        error.status = 405;
        throw error;
      }
      if (url.pathname === "/api/v1/nodes/enroll" && request.method === "POST") {
        if (!pool) { const error = new Error("Node enrollment is not configured with a database."); error.status = 503; throw error; }
        const body = await readJson(request);
        const token = requireText(body.enrollment_token, "enrollment_token", 256);
        const name = requireText(body.name, "name", 100);
        const platform = requireText(body.platform, "platform", 20).toLowerCase();
        const architecture = requireText(body.architecture, "architecture", 40);
        if (!["linux", "android", "windows", "macos", "other"].includes(platform)) { const error = new Error("Unsupported node platform."); error.status = 400; throw error; }
        const agentVersion = body.agent_version == null ? null : requireText(body.agent_version, "agent_version", 40);
        const capabilities = body.capabilities == null ? {} : body.capabilities;
        if (!capabilities || Array.isArray(capabilities) || typeof capabilities !== "object" || Buffer.byteLength(JSON.stringify(capabilities), "utf8") > 8192) { const error = new Error("capabilities must be a JSON object of at most 8 KiB."); error.status = 400; throw error; }
        const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
        const credential = randomBytes(32).toString("base64url");
        const credentialHash = createHash("sha256").update(credential, "utf8").digest("hex");
        const enrolled = await withNodeEnrollment(pool, { tokenHash, name, platform, architecture, agentVersion, capabilities, credentialHash });
        if (!enrolled) { const error = new Error("Enrollment token is invalid, expired or already used."); error.status = 401; throw error; }
        send(response, 201, { node: { id: enrolled.node_id, tenant_id: enrolled.tenant_id, name, platform, architecture, status: "pending" }, credential: { id: enrolled.credential_id, secret: credential, expires_in_days: 90 } }, requestId);
        return true;
      }

      const heartbeatMatch = url.pathname.match(/^\/api\/v1\/nodes\/([0-9a-f-]{36})\/heartbeat$/i);
      if (heartbeatMatch && request.method === "POST") {
        if (!pool) { const error = new Error("Node heartbeat is not configured with a database."); error.status = 503; throw error; }
        const nodeId = requireUuid(heartbeatMatch[1], "node_id");
        const credential = String(request.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{40,128})$/)?.[1];
        if (!credential) { const error = new Error("A valid node credential is required."); error.status = 401; throw error; }
        const body = await readJson(request);
        if (!["healthy", "degraded"].includes(body.health_status)) { const error = new Error("health_status must be healthy or degraded."); error.status = 400; throw error; }
        const agentVersion = body.agent_version == null ? null : requireText(body.agent_version, "agent_version", 40);
        const resources = body.resources == null ? {} : body.resources;
        const allowed = new Set(["cpu_percent","memory_total_bytes","memory_used_bytes","disk_total_bytes","disk_available_bytes","load_1m","uptime_seconds","battery_percent","temperature_c"]);
        if (!resources || Array.isArray(resources) || typeof resources !== "object" || Buffer.byteLength(JSON.stringify(resources), "utf8") > 8192 || Object.keys(resources).length > 9 || Object.entries(resources).some(([key,value]) => !allowed.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e15 || ((key === "cpu_percent" || key === "battery_percent") && value > 100))) {
          const error = new Error("resources must contain only supported finite numeric metrics within their allowed ranges (8 KiB maximum)."); error.status = 400; throw error;
        }
        const credentialHash = createHash("sha256").update(credential, "utf8").digest("hex");
        const heartbeat = await withNodeHeartbeat(pool, { nodeId, credentialHash, agentVersion, healthStatus: body.health_status, resources });
        if (!heartbeat) { const error = new Error("Node credential is invalid, expired or revoked."); error.status = 401; throw error; }
        send(response, 200, { node: { id: heartbeat.node_id, status: heartbeat.status, last_seen_at: heartbeat.last_seen_at } }, requestId);
        return true;
      }

      const claimMatch = url.pathname.match(/^\/api\/v1\/nodes\/([0-9a-f-]{36})\/jobs\/claim$/i);
      if (claimMatch && request.method === "POST") {
        if (!pool) { const error = new Error("Node job polling is not configured with a database."); error.status = 503; throw error; }
        const nodeId = requireUuid(claimMatch[1], "node_id");
        const credential = nodeCredential(request);
        if (!credential) { const error = new Error("A valid node credential is required."); error.status = 401; throw error; }
        const body = await readJson(request);
        const limit = body.limit == null ? 1 : body.limit;
        const leaseSeconds = body.lease_seconds == null ? 60 : body.lease_seconds;
        if (!Number.isInteger(limit) || limit < 1 || limit > 10) { const error = new Error("limit must be an integer between 1 and 10."); error.status = 400; throw error; }
        if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) { const error = new Error("lease_seconds must be an integer between 15 and 300."); error.status = 400; throw error; }
        const credentialHash = createHash("sha256").update(credential, "utf8").digest("hex");
        const jobs = await withNodeJobClaim(pool, { nodeId, credentialHash, limit, leaseSeconds });
        if (jobs === null) { const error = new Error("Node credential is invalid, expired or revoked."); error.status = 401; throw error; }
        send(response, 200, { jobs }, requestId);
        return true;
      }

      const acknowledgeMatch = url.pathname.match(/^\/api\/v1\/nodes\/([0-9a-f-]{36})\/jobs\/([0-9a-f-]{36})\/ack$/i);
      if (acknowledgeMatch && request.method === "POST") {
        if (!pool) { const error = new Error("Node job acknowledgement is not configured with a database."); error.status = 503; throw error; }
        const nodeId = requireUuid(acknowledgeMatch[1], "node_id");
        const jobId = requireUuid(acknowledgeMatch[2], "job_id");
        const credential = nodeCredential(request);
        if (!credential) { const error = new Error("A valid node credential is required."); error.status = 401; throw error; }
        const body = await readJson(request);
        const attemptId = requireUuid(body.attempt_id, "attempt_id");
        const leaseToken = requireUuid(body.lease_token, "lease_token");
        if (!["accepted", "running", "succeeded", "failed", "rejected"].includes(body.status)) { const error = new Error("status must be accepted, running, succeeded, failed or rejected."); error.status = 400; throw error; }
        const resultCode = body.result_code == null ? null : requireText(body.result_code, "result_code", 80);
        const resultSummary = body.result_summary == null ? null : requireText(body.result_summary, "result_summary", 4000);
        const credentialHash = createHash("sha256").update(credential, "utf8").digest("hex");
        const acknowledgement = await withNodeJobAcknowledgement(pool, { nodeId, credentialHash, jobId, attemptId, leaseToken, status: body.status, resultCode, resultSummary });
        if (!acknowledgement) { const error = new Error("Job lease is invalid, expired, stale or does not belong to this node."); error.status = 409; throw error; }
        send(response, 200, { job: acknowledgement }, requestId);
        return true;
      }

      if (!pool) {
        const error = new Error("Authentication API is not configured with a database.");
        error.status = 503;
        throw error;
      }
      if (!verifyAccessToken) {
        const error = new Error("OIDC authentication is not configured.");
        error.status = 503;
        throw error;
      }
      const token = getBearerToken(request);
      const principal = await verifyAccessToken(token);
      const result = await withUserTransaction(pool, principal.identitySubject, async (client, user) => {
        const route = url.pathname.match(/^\/api\/v1\/tenants\/([0-9a-f-]{36})\/(applications|deployments|members|enrollment-tokens|nodes|jobs)(?:\/([0-9a-f-]{36})\/credentials\/([0-9a-f-]{36})\/revoke)?$/i);

        if (url.pathname === "/api/v1/auth/me" && request.method === "GET") {
          const memberships = await client.query(
            "SELECT tenant.id, tenant.name, tenant.slug, membership.role FROM tenant_memberships AS membership JOIN tenants AS tenant ON tenant.id = membership.tenant_id WHERE membership.user_id = $1 AND membership.status = 'active' AND tenant.status = 'active' ORDER BY tenant.name",
            [user.id]
          );
          return { status: 200, body: { user: { id: user.id, email: user.email, display_name: user.display_name }, tenants: memberships.rows } };
        }

        if (url.pathname === "/api/v1/tenants" && request.method === "GET") {
          const tenants = await client.query(
            "SELECT tenant.id, tenant.name, tenant.slug, tenant.status, membership.role FROM tenant_memberships AS membership JOIN tenants AS tenant ON tenant.id = membership.tenant_id WHERE membership.user_id = $1 AND membership.status = 'active' AND tenant.status = 'active' ORDER BY tenant.name",
            [user.id]
          );
          return { status: 200, body: { tenants: tenants.rows } };
        }

        if (!route || !UUID.test(route[1])) {
          const error = new Error("API route not found.");
          error.status = 404;
          throw error;
        }

        const tenantId = route[1];
        const resource = route[2];
        const role = await getMembership(client, tenantId, user.id);

        if (resource === "nodes" && request.method === "GET") {
          requirePermission(role, "read");
          const nodes = await client.query("SELECT id, tenant_id, name, platform, architecture, agent_version, CASE WHEN status = 'revoked' THEN 'revoked' WHEN status = 'pending' THEN 'pending' WHEN last_seen_at IS NULL OR last_seen_at < now() - make_interval(secs => heartbeat_interval_seconds * 3) THEN 'offline' ELSE status END AS status, last_seen_at, heartbeat_interval_seconds, resource_metrics_json AS resources FROM nodes WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200", [tenantId]);
          return { status: 200, body: { nodes: nodes.rows } };
        }


        if (resource === "jobs" && request.method === "GET") {
          requirePermission(role, "read");
          const jobs = await client.query(
            "SELECT id, node_id, type, payload_json AS payload, status, attempt_count, max_attempts, available_at, lease_expires_at, created_at, updated_at FROM jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100",
            [tenantId]
          );
          return { status: 200, body: { jobs: jobs.rows } };
        }

        if (resource === "jobs" && request.method === "POST") {
          requirePermission(role, "manageJobs");
          const body = await readJson(request);
          const nodeId = requireUuid(body.node_id, "node_id");
          const type = requireText(body.type, "type", 40).toLowerCase();
          const payload = validateJobPayload(type, body.payload == null ? {} : body.payload);
          const idempotencyKey = requireText(body.idempotency_key, "idempotency_key", 128);
          if (idempotencyKey.length < 8 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
            const error = new Error("idempotency_key must be 8–128 characters using letters, numbers, dot, underscore, colon or hyphen.");
            error.status = 400;
            throw error;
          }
          const target = await client.query(
            "SELECT id, status, approved_at, last_seen_at, heartbeat_interval_seconds FROM nodes WHERE id = $1 AND tenant_id = $2 LIMIT 1",
            [nodeId, tenantId]
          );
          if (!target.rows[0]) { const error = new Error("Node not found."); error.status = 404; throw error; }
          const node = target.rows[0];
          if (!node.approved_at || !["online", "degraded"].includes(node.status) || !node.last_seen_at ||
              Date.now() - new Date(node.last_seen_at).getTime() > Number(node.heartbeat_interval_seconds) * 3000) {
            const error = new Error("Node must be approved and recently online before it can receive jobs.");
            error.status = 409;
            throw error;
          }
          let created = await client.query(
            "INSERT INTO jobs (tenant_id, node_id, type, payload_json, idempotency_key) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (tenant_id, node_id, idempotency_key) DO NOTHING RETURNING id, tenant_id, node_id, type, payload_json AS payload, status, attempt_count, max_attempts, created_at",
            [tenantId, nodeId, type, JSON.stringify(payload), idempotencyKey]
          );
          let status = 201;
          if (!created.rows[0]) {
            created = await client.query(
              "SELECT id, tenant_id, node_id, type, payload_json AS payload, status, attempt_count, max_attempts, created_at FROM jobs WHERE tenant_id = $1 AND node_id = $2 AND idempotency_key = $3 LIMIT 1",
              [tenantId, nodeId, idempotencyKey]
            );
            if (!created.rows[0] || created.rows[0].type !== type || JSON.stringify(created.rows[0].payload) !== JSON.stringify(payload)) {
              const error = new Error("idempotency_key has already been used for a different job.");
              error.status = 409;
              throw error;
            }
            status = 200;
          } else {
            await audit(client, tenantId, user.id, "node.job.created", "job", created.rows[0].id, { node_id: nodeId, type });
          }
          return { status, body: { job: created.rows[0] } };
        }

        if (resource === "applications" && request.method === "GET") {
          requirePermission(role, "read");
          const applications = await client.query(
            "SELECT id, tenant_id, name, desired_state, created_by, created_at, updated_at FROM applications WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100",
            [tenantId]
          );
          return { status: 200, body: { applications: applications.rows } };
        }

        if (resource === "applications" && request.method === "POST") {
          requirePermission(role, "manageApplications");
          const body = await readJson(request);
          const name = requireText(body.name, "name", 100);
          const created = await client.query(
            "INSERT INTO applications (tenant_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, tenant_id, name, desired_state, created_by, created_at",
            [tenantId, name, user.id]
          );
          await audit(client, tenantId, user.id, "application.created", "application", created.rows[0].id);
          return { status: 201, body: { application: created.rows[0] } };
        }

        if (resource === "deployments" && request.method === "GET") {
          requirePermission(role, "read");
          const deployments = await client.query(
            "SELECT id, tenant_id, application_id, revision, target_node_id, desired_state, status, created_by, created_at, updated_at FROM deployments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100",
            [tenantId]
          );
          return { status: 200, body: { deployments: deployments.rows } };
        }

        if (resource === "deployments" && request.method === "POST") {
          requirePermission(role, "operateDeployments");
          const body = await readJson(request);
          const applicationId = requireUuid(body.application_id, "application_id");
          const targetNodeId = body.target_node_id == null ? null : requireUuid(body.target_node_id, "target_node_id");
          const desiredState = body.desired_state;
          if (!["running", "stopped"].includes(desiredState)) {
            const error = new Error("desired_state must be running or stopped.");
            error.status = 400;
            throw error;
          }
          const revision = await client.query("SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision FROM deployments WHERE tenant_id = $1 AND application_id = $2", [tenantId, applicationId]);
          const created = await client.query(
            "INSERT INTO deployments (tenant_id, application_id, revision, target_node_id, desired_state, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, tenant_id, application_id, revision, target_node_id, desired_state, status, created_by, created_at",
            [tenantId, applicationId, Number(revision.rows[0].next_revision), targetNodeId, desiredState, user.id]
          );
          await audit(client, tenantId, user.id, "deployment.requested", "deployment", created.rows[0].id, { desired_state: desiredState });
          return { status: 201, body: { deployment: created.rows[0] } };
        }

        if (resource === "enrollment-tokens" && request.method === "POST") {
          requirePermission(role, "manageNodes");
          const body = await readJson(request);
          const lifetime = body.expires_in_minutes == null ? 30 : body.expires_in_minutes;
          if (!Number.isInteger(lifetime) || lifetime < 5 || lifetime > 1440) { const error = new Error("expires_in_minutes must be an integer between 5 and 1440."); error.status = 400; throw error; }
          const rawToken = randomBytes(32).toString("base64url");
          const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
          const created = await client.query("INSERT INTO enrollment_tokens (tenant_id, token_hash, expires_at, created_by) VALUES ($1, $2, now() + ($3 * interval '1 minute'), $4) RETURNING id, expires_at", [tenantId, tokenHash, lifetime, user.id]);
          await audit(client, tenantId, user.id, "node.enrollment_token.created", "enrollment_token", created.rows[0].id, { expires_in_minutes: lifetime });
          return { status: 201, body: { enrollment_token: { id: created.rows[0].id, token: rawToken, expires_at: created.rows[0].expires_at } } };
        }

        if (resource === "nodes" && route[3] && route[4] && request.method === "POST") {
          requirePermission(role, "manageNodes");
          const revoked = await client.query("UPDATE node_credentials AS credential SET revoked_at = now() FROM nodes AS node WHERE credential.id = $1 AND credential.node_id = $2 AND node.id = $2 AND node.tenant_id = $3 AND credential.revoked_at IS NULL RETURNING credential.id, credential.revoked_at", [route[4], route[3], tenantId]);
          if (!revoked.rows[0]) { const error = new Error("Node credential not found or already revoked."); error.status = 404; throw error; }
          const active = await client.query("SELECT count(*)::integer AS active_count FROM node_credentials WHERE node_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [route[3]]);
          const nodeStatus = Number(active.rows[0]?.active_count || 0) === 0 ? "revoked" : "unchanged";
          if (nodeStatus === "revoked") await client.query("UPDATE nodes SET status = 'revoked' WHERE id = $1 AND tenant_id = $2", [route[3], tenantId]);
          await audit(client, tenantId, user.id, "node.credential.revoked", "node_credential", revoked.rows[0].id, { node_id: route[3] });
          return { status: 200, body: { credential: { id: revoked.rows[0].id, revoked_at: revoked.rows[0].revoked_at }, node_status: nodeStatus } };
        }

        if (resource === "members" && request.method === "GET") {
          requirePermission(role, "read");
          const members = await client.query(
            "SELECT user_id, role, status, created_at FROM tenant_memberships WHERE tenant_id = $1 ORDER BY created_at",
            [tenantId]
          );
          return { status: 200, body: { members: members.rows } };
        }

        if (resource === "members" && request.method === "POST") {
          requirePermission(role, "manageMembers");
          const body = await readJson(request);
          const userId = requireUuid(body.user_id, "user_id");
          if (!canAssignRole(role, body.role)) throw new AuthorizationError("This role cannot be assigned by your tenant role.");
          const existing = await client.query("SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId]);
          if (existing.rowCount) {
            const error = new Error("This user already has a membership in the tenant.");
            error.status = 409;
            throw error;
          }
          await client.query(
            "INSERT INTO tenant_memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')",
            [tenantId, userId, body.role]
          );
          await audit(client, tenantId, user.id, "membership.created", "tenant_membership", userId, { role: body.role });
          return { status: 201, body: { membership: { tenant_id: tenantId, user_id: userId, role: body.role, status: "active" } } };
        }

        const error = new Error("API route not found.");
        error.status = 404;
        throw error;
      });

      send(response, result.status, result.body, requestId);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) logger.error?.("API request failed", { request_id: requestId, error: error.message });
      const code = status === 401 ? "UNAUTHENTICATED" :
        status === 403 ? (error.code || "FORBIDDEN") :
        status === 404 ? "NOT_FOUND" :
        status === 405 ? "METHOD_NOT_ALLOWED" :
        status === 409 ? "CONFLICT" :
        status === 413 ? "PAYLOAD_TOO_LARGE" :
        status === 415 ? "UNSUPPORTED_MEDIA_TYPE" :
        status === 400 ? "BAD_REQUEST" :
        status === 503 ? "SERVICE_UNAVAILABLE" : "INTERNAL_ERROR";
      const message = status >= 500 ? (status === 503 ? error.message : "The request could not be completed.") : error.message;
      send(response, status, { error: { code, message, request_id: requestId } }, requestId);
    }
    return true;
  };
}

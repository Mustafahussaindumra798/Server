import http from "node:http";
import { Duplex } from "node:stream";
import { domainToASCII } from "node:url";
import { isIP } from "node:net";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"
]);
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60000;

export function normalizeIngressHostname(value) {
  if (typeof value !== "string" || value.length > 300 || /[,\s/@?#]/.test(value)) return null;
  let host = value.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.includes("]")) return null;
  const colon = host.lastIndexOf(":");
  if (colon > -1) {
    if (!/^\d+$/.test(host.slice(colon + 1))) return null;
    host = host.slice(0, colon);
  }
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length > 253 || isIP(ascii) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(ascii)) return null;
  return ascii;
}

function cleanHeaders(headers, hostname, remoteAddress, protocol) {
  const connectionTokens = String(headers.connection || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const blocked = new Set([...HOP_BY_HOP, ...connectionTokens]);
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!blocked.has(name.toLowerCase()) && !name.toLowerCase().startsWith("x-forwarded-")) output[name] = value;
  }
  output.host = hostname;
  output["x-forwarded-host"] = hostname;
  output["x-forwarded-proto"] = protocol;
  output["x-forwarded-for"] = remoteAddress || "unknown";
  return output;
}

class TunnelDuplex extends Duplex {
  constructor() {
    super({ allowHalfOpen: false, autoDestroy: true });
    this.route = null;
    this.connecting = true;
    this.encrypted = false;
  }
  attach(route) {
    this.route = route;
    this.connecting = false;
    this.emit("connect");
  }
  receive(data) {
    if (!this.destroyed && !this.push(data)) this.route?.pause();
  }
  remoteClose(error = null) {
    if (error) this.destroy(error);
    else this.push(null);
  }
  _read() { this.route?.resume(); }
  _write(chunk, _encoding, callback) {
    if (!this.route) { callback(new Error("Tunnel route is not connected.")); return; }
    try {
      if (this.route.write(chunk)) callback();
      else if (!this.route.onDrain(callback)) callback(new Error("Tunnel route disconnected while writing."));
    } catch (error) { callback(error); }
  }
  _final(callback) {
    try { this.route?.close(); callback(); } catch (error) { callback(error); }
  }
  _destroy(error, callback) {
    try { this.route?.close(); } catch {}
    callback(error);
  }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout(_timeout, callback) { if (callback) this.once("timeout", callback); return this; }
  ref() { return this; }
  unref() { return this; }
}

export function createIngressRequestHandler({
  pool,
  routeStreams,
  signRouteGrant,
  certificate,
  logger = () => {},
  maxRequestBytes = MAX_REQUEST_BYTES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS
}) {
  if (!pool || typeof pool.query !== "function") throw new Error("Ingress database pool is required.");
  if (!routeStreams || typeof routeStreams.openStream !== "function" || typeof routeStreams.hasNode !== "function") {
    throw new Error("Authenticated route stream manager is required.");
  }
  if (typeof signRouteGrant !== "function") throw new Error("Route grant signer is required.");
  if (!certificate || typeof certificate.checkHost !== "function") throw new Error("A parsed TLS certificate is required.");
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1024 || maxRequestBytes > 1024 * 1024 * 1024) {
    throw new Error("Ingress request body limit is invalid.");
  }

  return async function handleIngress(request, response) {
    const hostname = normalizeIngressHostname(request.headers.host);
    if (!hostname) { response.writeHead(400, { connection: "close" }); response.end("Invalid Host header"); return; }
    if (!certificate.checkHost(hostname)) { response.writeHead(421, { connection: "close" }); response.end("Misdirected Request"); return; }
    if (request.method === "CONNECT" || request.method === "TRACE" || request.headers.upgrade) {
      response.writeHead(405, { allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" });
      response.end("Method not supported");
      return;
    }

    let route;
    try {
      const result = await pool.query(`
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
         WHERE claim.hostname = $1
           AND route.status = 'active'
           AND route.reason_code = 'transport_ready'
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
           AND node.capabilities_json->>'ingress_tunnel' = 'true'
           AND node.capabilities_json->>'loopback_forwarder' = 'true'
           AND node.last_seen_at > clock_timestamp() -
               make_interval(secs => node.heartbeat_interval_seconds * 3)
         LIMIT 1
      `, [hostname]);
      route = result.rows?.[0] || null;
    } catch (error) {
      logger("route_lookup_failed", { message: error.message });
      response.writeHead(503, { "retry-after": "5", connection: "close" });
      response.end("Ingress temporarily unavailable");
      return;
    }
    if (!route) { response.writeHead(404, { connection: "close" }); response.end("Route not found"); return; }
    if (!routeStreams.hasNode(route.node_id)) {
      response.writeHead(503, { "retry-after": "5", connection: "close" });
      response.end("Application node is unavailable");
      return;
    }

    let grant;
    try { grant = signRouteGrant(route).token; }
    catch (error) {
      logger("route_grant_failed", { route_id: route.route_id, message: error.message });
      response.writeHead(503, { connection: "close" });
      response.end("Route authorization unavailable");
      return;
    }

    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = (_options, callback) => {
      const tunnel = new TunnelDuplex();
      let routeStream;
      routeStreams.openStream({
        nodeId: route.node_id,
        grant,
        onData: ({ data }) => tunnel.receive(data),
        onClose: ({ error }) => tunnel.remoteClose(error)
      }).then((opened) => {
        routeStream = opened;
        tunnel.attach(opened);
        callback(null, tunnel);
      }).catch((error) => {
        tunnel.destroy(error);
        callback(error);
      });
      return tunnel;
    };

    const headers = cleanHeaders(request.headers, hostname, request.socket.remoteAddress, "https");
    const upstream = http.request({
      host: hostname,
      port: 80,
      method: request.method,
      path: request.url || "/",
      headers,
      agent,
      setHost: false,
      timeout: requestTimeoutMs,
      maxHeaderSize: 16 * 1024
    }, (upstreamResponse) => {
      const responseHeaders = {};
      const connectionTokens = String(upstreamResponse.headers.connection || "").split(",").map((v) => v.trim().toLowerCase());
      const blocked = new Set([...HOP_BY_HOP, ...connectionTokens]);
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !blocked.has(name.toLowerCase())) responseHeaders[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      upstreamResponse.pipe(response);
      upstreamResponse.once("end", () => agent.destroy());
    });

    let requestBytes = 0;
    request.on("data", (chunk) => {
      requestBytes += chunk.length;
      if (requestBytes > maxRequestBytes) {
        upstream.destroy(new Error("Ingress request body limit exceeded."));
        if (!response.headersSent) { response.writeHead(413, { connection: "close" }); response.end("Request body too large"); }
      }
    });
    request.once("aborted", () => upstream.destroy(new Error("Client request aborted.")));
    response.once("close", () => { if (!response.writableEnded) upstream.destroy(); agent.destroy(); });
    upstream.once("timeout", () => upstream.destroy(new Error("Ingress upstream timed out.")));
    upstream.once("error", (error) => {
      agent.destroy();
      logger("upstream_proxy_failed", { route_id: route.route_id, message: error.message });
      if (!response.headersSent) { response.writeHead(502, { connection: "close" }); response.end("Upstream unavailable"); }
      else response.destroy(error);
    });
    request.pipe(upstream);
  };
}

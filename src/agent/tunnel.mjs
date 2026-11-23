import tls from "node:tls";
import { X509Certificate } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import { createRouteForwarder } from "./route-forwarder.mjs";
import { setTimeout as sleep } from "node:timers/promises";

export const NODE_TUNNEL_ALPN = "cloudexify-node-tunnel/1";
const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FRAME_BYTES = 4096;

export class NodeTunnelAuthorizationError extends Error {}

export function parseTunnelUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("CLOUDEXIFY_TUNNEL_URL must be a valid HTTPS URL."); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CLOUDEXIFY_TUNNEL_URL must be an HTTPS origin without credentials, path, query or fragment.");
  }
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Tunnel gateway port is invalid.");
  return { host: url.hostname, port };
}

async function readPrivateFile(filePath, { privateKey = false } = {}) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Tunnel credential paths must be regular files, not symlinks.");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Tunnel credential files must be owned by the agent user.");
  if (privateKey && (info.mode & 0o077) !== 0) throw new Error("Tunnel private key permissions must be 0600 or stricter.");
  if (info.size > 128 * 1024) throw new Error("Tunnel credential file is too large.");
  return readFile(filePath);
}

export async function loadNodeTunnelCredentials({ nodeId, certPath, keyPath, caPath }) {
  if (!NODE_ID.test(nodeId || "")) throw new Error("Tunnel node ID is invalid.");
  if (![certPath, keyPath, caPath].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("Tunnel CA, client certificate and private key paths are required.");
  }
  const [cert, key, ca] = await Promise.all([
    readPrivateFile(certPath),
    readPrivateFile(keyPath, { privateKey: true }),
    readPrivateFile(caPath)
  ]);
  const parsed = new X509Certificate(cert);
  const commonName = parsed.subject.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("CN="))?.slice(3);
  if (commonName !== nodeId) throw new Error("Tunnel client certificate CN must exactly match the enrolled node ID.");
  const now = Date.now();
  if (Date.parse(parsed.validFrom) > now || Date.parse(parsed.validTo) <= now) throw new Error("Tunnel client certificate is not currently valid.");
  return { cert, key, ca };
}

function permanentTlsError(error) {
  return [
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
    "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
    "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
    "ERR_SSL_TLSV1_ALERT_CERTIFICATE_REVOKED",
    "ERR_SSL_TLSV1_ALERT_CERTIFICATE_EXPIRED",
    "ERR_SSL_TLSV1_ALERT_BAD_CERTIFICATE"
  ].includes(error?.code);
}

function writeFrame(socket, value) {
  const frame = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  if (frame.length > MAX_FRAME_BYTES) throw new Error("Tunnel control frame exceeds the protocol limit.");
  socket.write(frame);
}

function connectOnce({ connectImpl, endpoint, credentials, nodeId, signal, onState, handshakeTimeoutMs, routeGrantPublicKey }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const options = {
      host: endpoint.host,
      port: endpoint.port,
      ca: credentials.ca,
      cert: credentials.cert,
      key: credentials.key,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      ALPNProtocols: [NODE_TUNNEL_ALPN],
      ...(net.isIP(endpoint.host) ? {} : { servername: endpoint.host })
    };
    const socket = connectImpl(options);
    let settled = false;
    let welcomed = false;
    let routeForwarder = null;
    let buffer = "";
    let handshakeTimer;
    let connectTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(handshakeTimer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => socket.destroy();
    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish(signal.aborted ? null : new Error("Tunnel connection closed unexpectedly.")));
    connectTimer = setTimeout(() => socket.destroy(new Error("Tunnel TCP/TLS connection timed out.")), handshakeTimeoutMs * 3);
    socket.once("secureConnect", () => {
      clearTimeout(connectTimer);
      if (!socket.authorized || socket.alpnProtocol !== NODE_TUNNEL_ALPN) {
        socket.destroy(new NodeTunnelAuthorizationError("Tunnel gateway TLS identity or ALPN validation failed."));
        return;
      }
      try { writeFrame(socket, { type: "hello", protocol: 1, node_id: nodeId }); }
      catch (error) { socket.destroy(error); }
      handshakeTimer = setTimeout(() => socket.destroy(new Error("Tunnel handshake timed out.")), handshakeTimeoutMs);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > (welcomed ? 36 * 1024 : MAX_FRAME_BYTES)) {
        socket.destroy(new Error("Tunnel control frame exceeds the protocol limit."));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(new Error("Tunnel gateway sent an invalid control frame.")); return; }
        if (!welcomed) {
          if (message.type === "error") {
            socket.destroy(new NodeTunnelAuthorizationError("Tunnel gateway rejected node authorization."));
            return;
          }
          if (message.type !== "welcome" || message.protocol !== 1) {
            socket.destroy(new Error("Tunnel gateway handshake response is invalid."));
            return;
          }
          welcomed = true;
          clearTimeout(handshakeTimer);
          if (routeGrantPublicKey) {
            try { routeForwarder = createRouteForwarder({ nodeId, publicKeyPem: routeGrantPublicKey, tunnelSocket: socket }); }
            catch (error) { socket.destroy(error); return; }
          }
          onState("connected");
          continue;
        }
        if (message.type === "ping" && Number.isSafeInteger(message.sequence)) {
          try { writeFrame(socket, { type: "pong", sequence: message.sequence }); }
          catch (error) { socket.destroy(error); }
        } else if (routeForwarder && routeForwarder.handle(message)) {
          continue;
        } else {
          socket.destroy(new Error("Tunnel gateway sent an unsupported control message."));
          return;
        }
      }
    });
    if (signal.aborted) abort();
  });
}

export function startNodeTunnel({
  nodeId,
  gatewayUrl,
  credentials,
  connectImpl = tls.connect,
  signal,
  onState = () => {},
  minBackoffMs = 1000,
  maxBackoffMs = 30000,
  random = Math.random,
  sleepImpl = sleep,
  handshakeTimeoutMs = 5000,
  routeGrantPublicKey = null
}) {
  if (!NODE_ID.test(nodeId || "")) throw new Error("Tunnel node ID is invalid.");
  const endpoint = parseTunnelUrl(gatewayUrl);
  if (!credentials?.cert || !credentials?.key || !credentials?.ca) throw new Error("Tunnel client credentials are incomplete.");
  if (!signal) throw new Error("Tunnel AbortSignal is required.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", abort, { once: true });
  const runSignal = controller.signal;

  const done = (async () => {
    let backoff = minBackoffMs;
    while (!runSignal.aborted) {
      try {
        onState("connecting");
        await connectOnce({ connectImpl, endpoint, credentials, nodeId, signal: runSignal, onState, handshakeTimeoutMs, routeGrantPublicKey });
        backoff = minBackoffMs;
      } catch (error) {
        if (error instanceof NodeTunnelAuthorizationError || permanentTlsError(error)) {
          onState("rejected");
          break;
        }
        onState("disconnected");
      }
      if (runSignal.aborted) break;
      const delay = Math.min(maxBackoffMs, Math.max(minBackoffMs, Math.floor(backoff * (0.75 + random() * 0.5))));
      try { await sleepImpl(delay, undefined, { signal: runSignal }); }
      catch { if (!runSignal.aborted) throw new Error("Tunnel reconnect wait failed."); }
      backoff = Math.min(maxBackoffMs, backoff * 2);
    }
    signal.removeEventListener("abort", abort);
    onState("stopped");
  })();

  return {
    done,
    close() { controller.abort(); }
  };
}

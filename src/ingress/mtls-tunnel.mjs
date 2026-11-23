import tls from "node:tls";

export const NODE_TUNNEL_ALPN = "cloudexify-node-tunnel/1";
const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FRAME_BYTES = 4096;

function writeFrame(socket, value) {
  const frame = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  if (frame.length > MAX_FRAME_BYTES) throw new Error("Tunnel control frame exceeds the protocol limit.");
  socket.write(frame);
}

export function getTunnelPeerIdentity(socket) {
  const certificate = socket.getPeerCertificate(true);
  const fingerprint = String(certificate?.fingerprint256 || "").replace(/:/g, "").toLowerCase();
  const commonName = certificate?.subject?.CN;
  if (!socket.authorized || socket.alpnProtocol !== NODE_TUNNEL_ALPN ||
      !/^[0-9a-f]{64}$/.test(fingerprint) || typeof commonName !== "string" || !NODE_ID.test(commonName)) {
    throw new Error("Tunnel peer certificate, authorization or ALPN is invalid.");
  }
  return { nodeId: commonName, fingerprintSha256: fingerprint, serialNumber: String(certificate.serialNumber || "") };
}

export function createNodeTunnelServer({
  tlsOptions,
  authorizeCertificate,
  onConnection = () => {},
  pingIntervalMs = 15000,
  authorizationRecheckMs = 15000,
  handshakeTimeoutMs = 5000,
  createServer = tls.createServer
}) {
  if (!tlsOptions?.key || !tlsOptions?.cert || !tlsOptions?.ca) throw new Error("Gateway TLS key, certificate and client CA are required.");
  if (typeof authorizeCertificate !== "function") throw new Error("A database-backed node certificate authorizer is required.");
  if (![pingIntervalMs, authorizationRecheckMs, handshakeTimeoutMs].every((n) => Number.isInteger(n) && n >= 1000 && n <= 120000)) {
    throw new Error("Tunnel timing options are outside safe bounds.");
  }
  const server = createServer({
    ...tlsOptions,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
    ALPNProtocols: [NODE_TUNNEL_ALPN]
  }, (socket) => {
    let peer;
    try { peer = getTunnelPeerIdentity(socket); }
    catch { socket.destroy(); return; }
    let welcomed = false;
    let handshakeStarted = false;
    let rechecking = false;
    let sequence = 0;
    let buffer = "";
    let lastPongAt = Date.now();
    let pingTimer;
    let recheckTimer;
    const cleanup = () => {
      clearInterval(pingTimer);
      clearInterval(recheckTimer);
    };
    socket.once("close", cleanup);
    const rejectPeer = (code = null) => {
      if (!socket.destroyed) {
        if (code) {
          try { writeFrame(socket, { type: "error", code }); socket.end(); } catch { socket.destroy(); }
        } else {
          socket.destroy();
        }
      }
      cleanup();
    };
    const authorize = async () => {
      try {
        const allowed = await authorizeCertificate({
          fingerprintSha256: peer.fingerprintSha256,
          nodeId: peer.nodeId,
          serialNumber: peer.serialNumber
        });
        return allowed === true;
      } catch { return false; }
    };
    const start = async () => {
      if (!(await authorize())) { rejectPeer("NODE_TUNNEL_REVOKED"); return; }
      welcomed = true;
      writeFrame(socket, { type: "welcome", protocol: 1, heartbeat_interval_ms: pingIntervalMs });
      onConnection({ nodeId: peer.nodeId, fingerprintSha256: peer.fingerprintSha256, serialNumber: peer.serialNumber });
      pingTimer = setInterval(() => {
        if (Date.now() - lastPongAt > pingIntervalMs * 3) { rejectPeer(); return; }
        sequence += 1;
        try { writeFrame(socket, { type: "ping", sequence }); } catch { rejectPeer(); }
      }, pingIntervalMs);
      recheckTimer = setInterval(async () => {
        if (rechecking || socket.destroyed) return;
        rechecking = true;
        try {
          if (!(await authorize())) rejectPeer("NODE_TUNNEL_REVOKED");
        } finally {
          rechecking = false;
        }
      }, authorizationRecheckMs);
      pingTimer.unref?.();
      recheckTimer.unref?.();
    };
    const handshakeTimer = setTimeout(() => { if (!welcomed) rejectPeer(); }, handshakeTimeoutMs);
    handshakeTimer.unref?.();
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) { rejectPeer(); return; }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { rejectPeer(); return; }
        if (!welcomed) {
          if (handshakeStarted || message.type !== "hello" || message.protocol !== 1 || message.node_id !== peer.nodeId) {
            rejectPeer();
            return;
          }
          handshakeStarted = true;
          clearTimeout(handshakeTimer);
          void start();
        } else if (message.type === "pong" && Number.isSafeInteger(message.sequence) && message.sequence <= sequence) {
          lastPongAt = Date.now();
        } else {
          rejectPeer();
          return;
        }
      }
    });
    socket.once("error", cleanup);
  });
  return server;
}

export function createTunnelCertificateAuthorizer(pool) {
  if (!pool || typeof pool.query !== "function") throw new Error("A database pool is required for tunnel certificate authorization.");
  return async ({ fingerprintSha256, nodeId }) => {
    if (!/^[0-9a-f]{64}$/.test(fingerprintSha256 || "") || !NODE_ID.test(nodeId || "")) return false;
    const result = await pool.query(
      "SELECT app_private.authorize_node_tunnel_certificate($1, $2) AS authorized",
      [fingerprintSha256, nodeId]
    );
    return result.rows?.[0]?.authorized === true;
  };
}

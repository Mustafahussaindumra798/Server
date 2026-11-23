import net from "node:net";
import { verifyRouteGrant } from "./route-grants.mjs";

const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_STREAMS = 32;
const MAX_DATA_BYTES = 24 * 1024;
const MAX_CONSUMED_GRANTS = 10000;

function send(socket, message) {
  const frame = Buffer.from(JSON.stringify(message) + "\n", "utf8");
  if (frame.length > 36 * 1024) throw new Error("Route stream frame exceeds protocol limit.");
  if (!socket.write(frame)) return false;
  return true;
}

export function createRouteForwarder({
  nodeId,
  publicKeyPem,
  tunnelSocket,
  connectImpl = net.connect,
  maxStreams = MAX_STREAMS,
  idleTimeoutMs = 120000
}) {
  if (typeof publicKeyPem !== "string" || !publicKeyPem.trim()) throw new Error("Route grant public key is required.");
  if (!tunnelSocket || typeof tunnelSocket.write !== "function") throw new Error("An authenticated tunnel socket is required.");
  if (!Number.isInteger(maxStreams) || maxStreams < 1 || maxStreams > MAX_STREAMS) throw new Error("Route stream limit is invalid.");
  const consumed = new Set();
  const streams = new Map();
  let closed = false;

  function closeStream(id, reason = "closed", notify = true) {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    clearTimeout(stream.idleTimer);
    stream.local.destroy();
    if (notify && !closed && !tunnelSocket.destroyed) {
      try { send(tunnelSocket, { type: "route_close", stream_id: id, reason }); } catch {}
    }
  }

  function closeAll() {
    closed = true;
    for (const id of [...streams.keys()]) closeStream(id, "tunnel_closed", false);
  }

  function touch(stream) {
    clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(() => closeStream(stream.id, "idle_timeout"), idleTimeoutMs);
    stream.idleTimer.unref?.();
  }

  function open(message) {
    const id = message.stream_id;
    if (!STREAM_ID.test(id || "") || streams.has(id) || streams.size >= maxStreams ||
        typeof message.grant !== "string" || message.grant.length > 8192) {
      if (STREAM_ID.test(id || "")) send(tunnelSocket, { type: "route_error", stream_id: id, code: "OPEN_REJECTED" });
      return false;
    }
    let claims;
    try {
      claims = verifyRouteGrant(message.grant, publicKeyPem, { expectedNodeId: nodeId, consumedJtis: consumed });
    } catch {
      send(tunnelSocket, { type: "route_error", stream_id: id, code: "GRANT_REJECTED" });
      return false;
    }
    if (consumed.size >= MAX_CONSUMED_GRANTS) {
      send(tunnelSocket, { type: "route_error", stream_id: id, code: "GRANT_CAPACITY" });
      return false;
    }
    const local = connectImpl({ host: "127.0.0.1", port: claims.upstream.port });
    const stream = { id, local, idleTimer: null, connected: false };
    streams.set(id, stream);
    touch(stream);
    local.setNoDelay?.(true);
    local.once("connect", () => {
      if (!streams.has(id)) return;
      stream.connected = true;
      try { send(tunnelSocket, { type: "route_opened", stream_id: id }); }
      catch { closeStream(id, "tunnel_write_failed", false); }
    });
    tunnelSocket.on?.("drain", () => local.resume());
    local.on("drain", () => tunnelSocket.resume?.());
    local.on("data", (chunk) => {
      if (!streams.has(id)) return;
      touch(stream);
      for (let offset = 0; offset < chunk.length; offset += MAX_DATA_BYTES) {
        const part = chunk.subarray(offset, offset + MAX_DATA_BYTES);
        try {
          const writable = send(tunnelSocket, { type: "route_data", stream_id: id, data: part.toString("base64") });
          if (!writable) local.pause();
        } catch { closeStream(id, "tunnel_write_failed", false); return; }
      }
    });
    local.once("error", () => {
      if (!stream.connected) {
        try { send(tunnelSocket, { type: "route_error", stream_id: id, code: "UPSTREAM_UNAVAILABLE" }); } catch {}
      }
      closeStream(id, "upstream_error", false);
    });
    local.once("close", () => closeStream(id, "upstream_closed"));
    return true;
  }

  function handle(message) {
    if (closed || !message || typeof message !== "object") return false;
    if (message.type === "route_open") return open(message);
    if (message.type === "route_data") {
      const stream = streams.get(message.stream_id);
      if (!stream || typeof message.data !== "string" || message.data.length > Math.ceil(MAX_DATA_BYTES * 4 / 3) + 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) return false;
      const data = Buffer.from(message.data, "base64");
      if (!data.length || data.length > MAX_DATA_BYTES || data.toString("base64") !== message.data) return false;
      touch(stream);
      if (!stream.local.write(data)) tunnelSocket.pause?.();
      return true;
    }
    if (message.type === "route_close") {
      if (!STREAM_ID.test(message.stream_id || "")) return false;
      closeStream(message.stream_id, "remote_closed", false);
      return true;
    }
    return false;
  }

  function resume(streamId) {
    const stream = streams.get(streamId);
    if (stream) stream.local.resume();
  }

  tunnelSocket.once?.("close", closeAll);
  tunnelSocket.once?.("error", closeAll);
  return {
    handle,
    resume,
    close: closeAll,
    get activeStreams() { return streams.size; },
    get consumedGrantCount() { return consumed.size; }
  };
}

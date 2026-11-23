import { randomUUID } from "node:crypto";

const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_STREAMS_PER_NODE = 32;
const MAX_DATA_BYTES = 24 * 1024;
const MAX_FRAME_BYTES = 36 * 1024;

function writeFrame(socket, message) {
  const frame = Buffer.from(JSON.stringify(message) + "\n", "utf8");
  if (frame.length > MAX_FRAME_BYTES) throw new Error("Route gateway frame exceeds protocol limit.");
  if (socket.destroyed) throw new Error("Node tunnel is disconnected.");
  return socket.write(frame);
}

function decodeData(value) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_DATA_BYTES * 4 / 3) + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Route data frame is malformed.");
  }
  const data = Buffer.from(value, "base64");
  if (!data.length || data.length > MAX_DATA_BYTES || data.toString("base64") !== value) {
    throw new Error("Route data frame is outside the allowed size.");
  }
  return data;
}

export function createRouteStreamManager({
  maxStreamsPerNode = MAX_STREAMS_PER_NODE,
  openTimeoutMs = 10000,
  onStreamData = () => {},
  onStreamClose = () => {}
} = {}) {
  if (!Number.isInteger(maxStreamsPerNode) || maxStreamsPerNode < 1 || maxStreamsPerNode > MAX_STREAMS_PER_NODE) {
    throw new Error("Gateway per-node stream limit is invalid.");
  }
  if (!Number.isInteger(openTimeoutMs) || openTimeoutMs < 1000 || openTimeoutMs > 60000) {
    throw new Error("Gateway stream-open timeout is invalid.");
  }

  const nodes = new Map();
  const streams = new Map();

  function finish(stream, error = null, notifyNode = false) {
    if (!streams.has(stream.id)) return;
    streams.delete(stream.id);
    const node = nodes.get(stream.nodeId);
    if (node) node.streamIds.delete(stream.id);
    clearTimeout(stream.timer);
    if (notifyNode && node && !node.socket.destroyed) {
      try { writeFrame(node.socket, { type: "route_close", stream_id: stream.id, reason: "gateway_closed" }); } catch {}
    }
    if (!stream.settled) {
      stream.settled = true;
      if (error) stream.reject(error);
      else stream.resolve();
    }
    try { onStreamClose({ streamId: stream.id, nodeId: stream.nodeId, error }); } catch {}
  }

  function attachNode({ nodeId, socket }) {
    if (typeof nodeId !== "string" || !socket || typeof socket.write !== "function") {
      throw new Error("Authenticated node ID and tunnel socket are required.");
    }
    detachNode(nodeId, new Error("Node tunnel session replaced."));
    nodes.set(nodeId, { socket, streamIds: new Set() });
  }

  function detachNode(nodeId, reason = new Error("Node tunnel disconnected.")) {
    const node = nodes.get(nodeId);
    if (!node) return;
    nodes.delete(nodeId);
    for (const id of [...node.streamIds]) {
      const stream = streams.get(id);
      if (stream) finish(stream, reason, false);
    }
  }

  function openStream({ nodeId, grant, onData = onStreamData, onClose = onStreamClose }) {
    const node = nodes.get(nodeId);
    if (!node || node.socket.destroyed) return Promise.reject(new Error("No authenticated tunnel is available for this node."));
    if (node.streamIds.size >= maxStreamsPerNode) return Promise.reject(new Error("Node route stream capacity is exhausted."));
    if (typeof grant !== "string" || grant.length < 1 || grant.length > 8192) return Promise.reject(new Error("Signed route grant is invalid."));
    const id = randomUUID().replace(/-/g, "");
    let resolve;
    let reject;
    const opened = new Promise((res, rej) => { resolve = res; reject = rej; });
    const stream = { id, nodeId, resolve, reject, settled: false, opened: false, timer: null, onData, onClose };
    streams.set(id, stream);
    node.streamIds.add(id);
    stream.timer = setTimeout(() => finish(stream, new Error("Node route stream open timed out."), true), openTimeoutMs);
    stream.timer.unref?.();
    try { writeFrame(node.socket, { type: "route_open", stream_id: id, grant }); }
    catch (error) { finish(stream, error, false); }
    return opened.then(() => ({
      id,
      write(data) {
        if (!streams.has(id)) throw new Error("Route stream is no longer active.");
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!bytes.length || bytes.length > MAX_DATA_BYTES) throw new Error("Route stream write exceeds the frame limit.");
        writeFrame(node.socket, { type: "route_data", stream_id: id, data: bytes.toString("base64") });
      },
      close() {
        const current = streams.get(id);
        if (current) finish(current, null, true);
      }
    }));
  }

  function handleNodeMessage(nodeId, message) {
    const node = nodes.get(nodeId);
    if (!node || !message || typeof message !== "object" || Array.isArray(message) ||
        typeof message.stream_id !== "string" || !STREAM_ID.test(message.stream_id)) return false;
    const stream = streams.get(message.stream_id);
    if (!stream || stream.nodeId !== nodeId) return false;
    if (message.type === "route_opened") {
      if (stream.opened) return false;
      stream.opened = true;
      clearTimeout(stream.timer);
      if (!stream.settled) { stream.settled = true; stream.resolve(); }
      return true;
    }
    if (message.type === "route_data") {
      if (!stream.opened) return false;
      let data;
      try { data = decodeData(message.data); } catch { return false; }
      try { stream.onData({ streamId: stream.id, nodeId, data }); }
      catch { finish(stream, new Error("Gateway route data consumer failed."), true); }
      return true;
    }
    if (message.type === "route_close") {
      if (typeof message.reason !== "undefined" && (typeof message.reason !== "string" || message.reason.length > 64)) return false;
      finish(stream, null, false);
      try { stream.onClose({ streamId: stream.id, nodeId, reason: message.reason || "node_closed" }); } catch {}
      return true;
    }
    if (message.type === "route_error") {
      if (typeof message.code !== "string" || !/^[A-Z0-9_]{1,64}$/.test(message.code)) return false;
      finish(stream, new Error("Node rejected route stream: " + message.code), false);
      return true;
    }
    return false;
  }

  function closeAll() {
    for (const nodeId of [...nodes.keys()]) detachNode(nodeId, new Error("Gateway route manager stopped."));
  }

  return {
    attachNode,
    detachNode,
    openStream,
    handleNodeMessage,
    closeAll,
    get activeNodes() { return nodes.size; },
    get activeStreams() { return streams.size; }
  };
}

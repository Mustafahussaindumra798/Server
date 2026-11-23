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
  onStreamClose = () => {},
  drainTimeoutMs = 30000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout
} = {}) {
  if (!Number.isInteger(maxStreamsPerNode) || maxStreamsPerNode < 1 || maxStreamsPerNode > MAX_STREAMS_PER_NODE) {
    throw new Error("Gateway per-node stream limit is invalid.");
  }
  if (!Number.isInteger(openTimeoutMs) || openTimeoutMs < 1000 || openTimeoutMs > 60000) {
    throw new Error("Gateway stream-open timeout is invalid.");
  }
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1000 || drainTimeoutMs > 120000 ||
      typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
    throw new Error("Gateway route drain timeout configuration is invalid.");
  }

  const nodes = new Map();
  const streams = new Map();

  function finish(stream, error = null, notifyNode = false) {
    if (!streams.has(stream.id)) return;
    streams.delete(stream.id);
    const node = nodes.get(stream.nodeId);
    if (node) {
      node.streamIds.delete(stream.id);
      if (node.draining && node.streamIds.size === 0) node.drainResolve?.(true);
    }
    clearTimeout(stream.timer);
    for (const listener of stream.drainCallbacks) stream.socket.off?.("drain", listener);
    stream.drainCallbacks.clear();
    if (notifyNode && node && !node.socket.destroyed) {
      try { writeFrame(node.socket, { type: "route_close", stream_id: stream.id, reason: "gateway_closed" }); } catch {}
    }
    if (!stream.settled) {
      stream.settled = true;
      if (error) stream.reject(error);
      else stream.resolve();
    }
    try { stream.onClose({ streamId: stream.id, nodeId: stream.nodeId, error }); } catch {}
  }

  function attachNode({ nodeId, socket }) {
    if (typeof nodeId !== "string" || !socket || typeof socket.write !== "function") {
      throw new Error("Authenticated node ID and tunnel socket are required.");
    }
    detachNode(nodeId, new Error("Node tunnel session replaced."));
    nodes.set(nodeId, { socket, streamIds: new Set(), draining: false, drainResolve: null, drainPromise: null, drainCancel: null });
  }

  function detachNode(nodeId, reason = new Error("Node tunnel disconnected.")) {
    const node = nodes.get(nodeId);
    if (!node) return;
    nodes.delete(nodeId);
    for (const id of [...node.streamIds]) {
      node.streamIds.delete(id);
      const stream = streams.get(id);
      if (stream) finish(stream, reason, false);
    }
    node.drainResolve?.(false);
  }

  function openStream({ nodeId, grant, onData = onStreamData, onClose = onStreamClose }) {
    const node = nodes.get(nodeId);
    if (!node || node.socket.destroyed) return Promise.reject(new Error("No authenticated tunnel is available for this node."));
    if (node.draining) return Promise.reject(new Error("Node route streams are draining; new streams are not accepted."));
    if (node.streamIds.size >= maxStreamsPerNode) return Promise.reject(new Error("Node route stream capacity is exhausted."));
    if (typeof grant !== "string" || grant.length < 1 || grant.length > 8192) return Promise.reject(new Error("Signed route grant is invalid."));
    const id = randomUUID().replace(/-/g, "");
    let resolve;
    let reject;
    const opened = new Promise((res, rej) => { resolve = res; reject = rej; });
    const stream = { id, nodeId, socket: node.socket, drainCallbacks: new Set(), resolve, reject, settled: false, opened: false, timer: null, onData, onClose };
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
        return writeFrame(node.socket, { type: "route_data", stream_id: id, data: bytes.toString("base64") });
      },
      pause() {
        if (!streams.has(id)) return false;
        return writeFrame(node.socket, { type: "route_pause", stream_id: id });
      },
      resume() {
        if (!streams.has(id)) return false;
        return writeFrame(node.socket, { type: "route_resume", stream_id: id });
      },
      onDrain(callback) {
        if (typeof callback !== "function") throw new Error("A drain callback is required.");
        if (!streams.has(id) || stream.socket.destroyed) return false;
        const listener = () => {
          stream.drainCallbacks.delete(listener);
          callback();
        };
        stream.drainCallbacks.add(listener);
        stream.socket.once("drain", listener);
        return true;
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
      finish(stream, stream.opened ? null : new Error("Node closed the route before it opened."), false);
      return true;
    }
    if (message.type === "route_error") {
      if (typeof message.code !== "string" || !/^[A-Z0-9_]{1,64}$/.test(message.code)) return false;
      finish(stream, new Error("Node rejected route stream: " + message.code), false);
      return true;
    }
    return false;
  }

  async function drainNode(nodeId, { timeoutMs = drainTimeoutMs } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
      throw new Error("Node route drain timeout is invalid.");
    }
    const node = nodes.get(nodeId);
    if (!node || node.socket.destroyed) return { drained: true, activeStreams: 0 };
    if (node.draining && node.drainPromise) return node.drainPromise;
    node.draining = true;
    if (node.streamIds.size === 0) return { drained: true, activeStreams: 0 };

    const drainPromise = new Promise((resolve) => {
      let settled = false;
      let timer;
      let onStreamsDrained;
      const finishDrain = (drained) => {
        if (settled) return;
        settled = true;
        clearTimeoutImpl(timer);
        if (node.drainResolve === onStreamsDrained) node.drainResolve = null;
        node.drainCancel = null;
        node.drainPromise = null;
        const activeStreams = node.streamIds.size;
        if (!drained && nodes.get(nodeId) === node) {
          detachNode(nodeId, new Error("Node route drain timed out."));
        }
        resolve({ drained, activeStreams: drained ? 0 : activeStreams });
      };
      onStreamsDrained = (drained = true) => finishDrain(drained);
      node.drainResolve = onStreamsDrained;
      node.drainCancel = () => {
        if (settled) return;
        settled = true;
        clearTimeoutImpl(timer);
        if (node.drainResolve === onStreamsDrained) node.drainResolve = null;
        node.drainCancel = null;
        node.drainPromise = null;
        node.draining = false;
        resolve({ drained: false, activeStreams: node.streamIds.size });
      };
      timer = setTimeoutImpl(() => finishDrain(false), timeoutMs);
      timer?.unref?.();
      if (node.streamIds.size === 0) onStreamsDrained();
    });
    node.drainPromise = drainPromise;
    return drainPromise;
  }

  function resumeNode(nodeId) {
    const node = nodes.get(nodeId);
    if (!node) return false;
    if (node.drainCancel) node.drainCancel();
    node.draining = false;
    return true;
  }

  function syncNodeDrainStates(drainingNodeIds) {
    if (!Array.isArray(drainingNodeIds) || drainingNodeIds.some((id) => typeof id !== "string")) {
      throw new Error("Draining node IDs must be an array of strings.");
    }
    const draining = new Set(drainingNodeIds);
    for (const nodeId of nodes.keys()) {
      if (draining.has(nodeId)) void drainNode(nodeId);
      else resumeNode(nodeId);
    }
  }

  function closeAll() {
    for (const nodeId of [...nodes.keys()]) detachNode(nodeId, new Error("Gateway route manager stopped."));
  }

  return {
    attachNode,
    detachNode,
    drainNode,
    resumeNode,
    syncNodeDrainStates,
    openStream,
    handleNodeMessage,
    closeAll,
    hasNode(nodeId) { const node = nodes.get(nodeId); return Boolean(node && !node.socket.destroyed); },
    get connectedNodeIds() { return [...nodes.entries()].filter(([, node]) => !node.socket.destroyed).map(([nodeId]) => nodeId); },
    get activeNodes() { return nodes.size; },
    get activeStreams() { return streams.size; }
  };
}

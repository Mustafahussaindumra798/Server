import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRouteStreamManager } from "../src/ingress/route-streams.mjs";

const nodeId = "30000000-0000-4000-8000-000000000001";

class FakeSocket extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.frames = []; }
  write(frame) { this.frames.push(JSON.parse(String(frame))); return true; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("gateway multiplexes an authenticated node stream and relays bounded data", async () => {
  const received = [];
  const manager = createRouteStreamManager({ onStreamData: (event) => received.push(event.data.toString()) });
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  const pending = manager.openStream({ nodeId, grant: "signed-grant" });
  const open = socket.frames[0];
  assert.equal(open.type, "route_open");
  assert.equal(typeof open.stream_id, "string");
  assert.equal(manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: open.stream_id }), true);
  const stream = await pending;
  stream.write(Buffer.from("hello"));
  assert.deepEqual(socket.frames.at(-1), {
    type: "route_data", stream_id: open.stream_id, data: Buffer.from("hello").toString("base64")
  });
  assert.equal(manager.handleNodeMessage(nodeId, {
    type: "route_data", stream_id: open.stream_id, data: Buffer.from("response").toString("base64")
  }), true);
  assert.deepEqual(received, ["response"]);
  stream.close();
  assert.equal(socket.frames.at(-1).type, "route_close");
  assert.equal(manager.activeStreams, 0);
});

test("gateway rejects cross-node, unknown, malformed and oversized stream frames", async () => {
  const manager = createRouteStreamManager();
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  const pending = manager.openStream({ nodeId, grant: "grant" });
  const id = socket.frames[0].stream_id;
  assert.equal(manager.handleNodeMessage("40000000-0000-4000-8000-000000000001", { type: "route_opened", stream_id: id }), false);
  assert.equal(manager.handleNodeMessage(nodeId, { type: "route_data", stream_id: id, data: "!!!!" }), false);
  assert.equal(manager.handleNodeMessage(nodeId, { type: "route_data", stream_id: id, data: Buffer.alloc(25 * 1024).toString("base64") }), false);
  assert.equal(manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: "unknown" }), false);
  manager.handleNodeMessage(nodeId, { type: "route_error", stream_id: id, code: "GRANT_REJECTED" });
  await assert.rejects(pending, /GRANT_REJECTED/);
  assert.equal(manager.activeStreams, 0);
});

test("gateway fails pending streams when node disconnects and enforces per-node cap", async () => {
  const manager = createRouteStreamManager({ maxStreamsPerNode: 1, openTimeoutMs: 10000 });
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  const pending = manager.openStream({ nodeId, grant: "grant" });
  await assert.rejects(manager.openStream({ nodeId, grant: "grant" }), /capacity/);
  manager.detachNode(nodeId);
  await assert.rejects(pending, /disconnected/);
  assert.equal(manager.activeStreams, 0);
});

test("gateway rejects a node close that arrives before route_opened", async () => {
  const manager = createRouteStreamManager();
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  const pending = manager.openStream({ nodeId, grant: "grant" });
  const id = socket.frames[0].stream_id;
  assert.equal(manager.handleNodeMessage(nodeId, { type: "route_close", stream_id: id, reason: "upstream_closed" }), true);
  await assert.rejects(pending, /before it opened/);
  assert.equal(manager.activeStreams, 0);
});

test("gateway sends stream-scoped pause and resume frames to the owning node", async () => {
  const manager = createRouteStreamManager();
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  assert.equal(manager.hasNode(nodeId), true);
  const pending = manager.openStream({ nodeId, grant: "grant" });
  const id = socket.frames[0].stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: id });
  const stream = await pending;
  stream.pause();
  stream.resume();
  assert.deepEqual(socket.frames.slice(-2).map((frame) => frame.type), ["route_pause", "route_resume"]);
  let staleDrainCallbackCalled = false;
  stream.onDrain(() => { staleDrainCallbackCalled = true; });
  stream.close();
  socket.emit("drain");
  assert.equal(staleDrainCallbackCalled, false);
  manager.detachNode(nodeId);
  assert.equal(manager.hasNode(nodeId), false);
});

test("gateway drains existing node streams and rejects new streams", async () => {
  const manager = createRouteStreamManager();
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  const pending = manager.openStream({ nodeId, grant: "grant" });
  const id = socket.frames[0].stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: id });
  const stream = await pending;

  const draining = manager.drainNode(nodeId, { timeoutMs: 5000 });
  assert.equal(manager.hasNode(nodeId), true);
  await assert.rejects(manager.openStream({ nodeId, grant: "new-grant" }), /draining/);
  stream.close();

  assert.deepEqual(await draining, { drained: true, activeStreams: 0 });
  assert.equal(manager.hasNode(nodeId), true);
  assert.equal(manager.activeStreams, 0);
});

test("gateway forcibly detaches a node when graceful route drain times out", async () => {
  let timeoutCallback;
  const manager = createRouteStreamManager({
    setTimeoutImpl(callback) {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeoutImpl() {}
  });
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  let closeError;
  const pending = manager.openStream({ nodeId, grant: "grant", onClose: ({ error }) => { closeError = error; } });
  const id = socket.frames[0].stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: id });
  await pending;
  assert.equal(manager.activeStreams, 1);

  const draining = manager.drainNode(nodeId, { timeoutMs: 5000 });
  assert.equal(typeof timeoutCallback, "function");
  timeoutCallback();
  assert.deepEqual(await draining, { drained: false, activeStreams: 1 });
  assert.equal(manager.hasNode(nodeId), false);
  assert.equal(socket.destroyed, true, "timed-out drain must close the mTLS socket to force a clean reconnect");
  assert.equal(manager.activeStreams, 0);
  assert.match(closeError.message, /drain timed out/);
});

test("gateway resolves a pending drain as unsuccessful when the node disconnects", async () => {
  const manager = createRouteStreamManager();
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  const pending = manager.openStream({ nodeId, grant: "grant" });
  const id = socket.frames[0].stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: id });
  await pending;

  const draining = manager.drainNode(nodeId, { timeoutMs: 5000 });
  manager.detachNode(nodeId, new Error("Node disconnected during drain."));
  assert.deepEqual(await draining, { drained: false, activeStreams: 0 });
  assert.equal(manager.hasNode(nodeId), false);
  assert.equal(manager.activeStreams, 0);
});
test("gateway makes concurrent drain requests share one drain operation", async () => {
  let timeoutCount = 0;
  let timeoutCallback;
  const manager = createRouteStreamManager({
    setTimeoutImpl(callback) {
      timeoutCount += 1;
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeoutImpl() {}
  });
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  const pending = manager.openStream({ nodeId, grant: "grant" });
  const id = socket.frames[0].stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: id });
  const stream = await pending;

  const firstDrain = manager.drainNode(nodeId, { timeoutMs: 5000 });
  const secondDrain = manager.drainNode(nodeId, { timeoutMs: 10000 });
  assert.equal(timeoutCount, 1);
  stream.close();
  assert.deepEqual(await firstDrain, { drained: true, activeStreams: 0 });
  assert.deepEqual(await secondDrain, { drained: true, activeStreams: 0 });
});

test("gateway handles a synchronously firing injected drain timer", async () => {
  const manager = createRouteStreamManager({
    setTimeoutImpl(callback) {
      callback();
      return { unref() {} };
    },
    clearTimeoutImpl() {}
  });
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  const pending = manager.openStream({ nodeId, grant: "grant" });
  const id = socket.frames[0].stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: id });
  await pending;

  assert.deepEqual(await manager.drainNode(nodeId), { drained: false, activeStreams: 1 });
  assert.equal(manager.hasNode(nodeId), false);
  assert.equal(manager.activeStreams, 0);
});


test("gateway can resume a node after a drain is cancelled", async () => {
  const manager = createRouteStreamManager();
  const socket = new FakeSocket();
  manager.attachNode({ nodeId, socket });
  const pending = manager.openStream({ nodeId, grant: "grant" });
  const id = socket.frames[0].stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: id });
  const stream = await pending;

  const drain = manager.drainNode(nodeId, { timeoutMs: 5000 });
  assert.equal(manager.resumeNode(nodeId), true);
  assert.deepEqual(await drain, { drained: false, activeStreams: 1 });
  const second = manager.openStream({ nodeId, grant: "second-grant" });
  const secondId = socket.frames.at(-1).stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: secondId });
  const secondStream = await second;
  stream.close();
  secondStream.close();
  assert.equal(manager.hasNode(nodeId), true);
});

test("gateway synchronizes drain state for every connected node", async () => {
  const manager = createRouteStreamManager();
  const first = new FakeSocket();
  const second = new FakeSocket();
  manager.attachNode({ nodeId, socket: first });
  const secondNodeId = "30000000-0000-4000-8000-000000000002";
  manager.attachNode({ nodeId: secondNodeId, socket: second });

  manager.syncNodeDrainStates([nodeId]);
  await assert.rejects(manager.openStream({ nodeId, grant: "blocked" }), /draining/);
  const opened = manager.openStream({ nodeId: secondNodeId, grant: "allowed" });
  const streamId = second.frames[0].stream_id;
  manager.handleNodeMessage(secondNodeId, { type: "route_opened", stream_id: streamId });
  const stream = await opened;
  stream.close();

  manager.syncNodeDrainStates([]);
  const resumed = manager.openStream({ nodeId, grant: "resumed" });
  const resumedId = first.frames.at(-1).stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: resumedId });
  (await resumed).close();
  manager.closeAll();
});


test("stale tunnel disconnect cannot detach a replacement node session", () => {
  const manager = createRouteStreamManager();
  const oldSocket = new FakeSocket();
  const newSocket = new FakeSocket();
  manager.attachNode({ nodeId, socket: oldSocket });
  manager.attachNode({ nodeId, socket: newSocket });

  manager.detachNode(nodeId, new Error("old session closed"), oldSocket);
  assert.equal(manager.hasNode(nodeId), true);

  const pending = manager.openStream({ nodeId, grant: "new-session-grant" });
  const id = newSocket.frames[0].stream_id;
  manager.handleNodeMessage(nodeId, { type: "route_opened", stream_id: id });
  return pending.then((stream) => stream.close());
});

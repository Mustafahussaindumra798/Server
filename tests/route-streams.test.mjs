import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRouteStreamManager } from "../src/ingress/route-streams.mjs";

const nodeId = "30000000-0000-4000-8000-000000000001";

class FakeSocket extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.frames = []; }
  write(frame) { this.frames.push(JSON.parse(String(frame))); return true; }
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
  stream.close();
  manager.detachNode(nodeId);
  assert.equal(manager.hasNode(nodeId), false);
});

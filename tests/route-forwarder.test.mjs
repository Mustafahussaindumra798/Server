import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { createRouteGrantSigner } from "../src/ingress/route-grants.mjs";
import { createRouteForwarder } from "../src/agent/route-forwarder.mjs";

const nodeId = "30000000-0000-4000-8000-000000000001";
const route = {
  route_id: "31000000-0000-4000-8000-000000000001",
  tenant_id: "20000000-0000-4000-8000-000000000001",
  hostname: "app.example.test",
  deployment_id: "50000000-0000-4000-8000-000000000001",
  node_id: nodeId,
  local_port: 32145,
  route_version: 1
};
const pair = generateKeyPairSync("ed25519");
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
const sign = createRouteGrantSigner(privatePem);

class TunnelSocket extends EventEmitter {
  constructor() { super(); this.frames = []; this.destroyed = false; }
  write(value) { this.frames.push(JSON.parse(String(value))); return true; }
  pause() {}
  resume() {}
}

test("forwarder opens only a signed grant endpoint on IPv4 loopback and relays bounded stream data", async (t) => {
  const upstream = net.createServer((socket) => socket.on("data", (data) => socket.write(data)));
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const port = upstream.address().port;
  const { token } = sign({ ...route, local_port: port });
  const tunnel = new TunnelSocket();
  const forwarder = createRouteForwarder({ nodeId, publicKeyPem: publicPem, tunnelSocket: tunnel });
  t.after(() => forwarder.close());
  assert.equal(forwarder.handle({ type: "route_open", stream_id: "s1", grant: token }), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(tunnel.frames.some((frame) => frame.type === "route_opened" && frame.stream_id === "s1"));
  assert.equal(forwarder.handle({ type: "route_data", stream_id: "s1", data: Buffer.from("hello").toString("base64") }), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(tunnel.frames.some((frame) => frame.type === "route_data" && frame.stream_id === "s1" && Buffer.from(frame.data, "base64").toString() === "hello"));
  assert.equal(forwarder.activeStreams, 1);
  forwarder.handle({ type: "route_close", stream_id: "s1" });
  assert.equal(forwarder.activeStreams, 0);
});

test("forwarder rejects replayed, wrong-node, expired and malformed route opens", () => {
  const tunnel = new TunnelSocket();
  const forwarder = createRouteForwarder({ nodeId, publicKeyPem: publicPem, tunnelSocket: tunnel, connectImpl: () => Object.assign(new EventEmitter(), { destroy() {} }) });
  const valid = sign(route).token;
  assert.equal(forwarder.handle({ type: "route_open", stream_id: "bad", grant: valid + "x" }), false);
  assert.equal(forwarder.handle({ type: "route_open", stream_id: "s1", grant: valid }), true);
  assert.equal(forwarder.handle({ type: "route_open", stream_id: "s2", grant: valid }), false);
  const wrongNode = sign({ ...route, node_id: "30000000-0000-4000-8000-000000000002" }).token;
  assert.equal(forwarder.handle({ type: "route_open", stream_id: "s3", grant: wrongNode }), false);
  const expired = sign(route, { now: Date.now() - 120000, ttlSeconds: 5 }).token;
  assert.equal(forwarder.handle({ type: "route_open", stream_id: "s4", grant: expired }), false);
  assert.ok(tunnel.frames.some((frame) => frame.type === "route_error" && frame.code === "GRANT_REJECTED"));
  forwarder.close();
});

test("forwarder rejects malformed stream IDs, oversized data and unknown stream references", () => {
  const tunnel = new TunnelSocket();
  const forwarder = createRouteForwarder({ nodeId, publicKeyPem: publicPem, tunnelSocket: tunnel });
  assert.equal(forwarder.handle({ type: "route_open", stream_id: "../etc/passwd", grant: sign(route).token }), false);
  assert.equal(forwarder.handle({ type: "route_data", stream_id: "missing", data: Buffer.from("x").toString("base64") }), false);
  assert.equal(forwarder.handle({ type: "route_data", stream_id: "missing", data: "A".repeat(40000) }), false);
  forwarder.close();
});

test("forwarder applies gateway pause and resume to the exact active upstream stream", async () => {
  class FakeLocal extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.paused = false; }
    setNoDelay() {}
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    write() { return true; }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  let local;
  const tunnel = new TunnelSocket();
  const forwarder = createRouteForwarder({
    nodeId,
    publicKeyPem: publicPem,
    tunnelSocket: tunnel,
    connectImpl: (options) => {
      assert.deepEqual(options, { host: "127.0.0.1", port: route.local_port });
      local = new FakeLocal();
      queueMicrotask(() => local.emit("connect"));
      return local;
    }
  });
  assert.equal(forwarder.handle({ type: "route_open", stream_id: "flow1", grant: sign(route).token }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarder.handle({ type: "route_pause", stream_id: "flow1" }), true);
  assert.equal(local.paused, true);
  assert.equal(forwarder.handle({ type: "route_resume", stream_id: "flow1" }), true);
  assert.equal(local.paused, false);
  assert.equal(forwarder.handle({ type: "route_pause", stream_id: "unknown" }), false);
  forwarder.close();
});

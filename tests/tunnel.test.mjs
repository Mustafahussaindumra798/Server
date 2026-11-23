import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  NODE_TUNNEL_ALPN as AGENT_ALPN,
  NodeTunnelAuthorizationError,
  parseTunnelUrl,
  startNodeTunnel
} from "../src/agent/tunnel.mjs";
import {
  NODE_TUNNEL_ALPN as GATEWAY_ALPN,
  getTunnelPeerIdentity,
  createNodeTunnelServer,
  createTunnelCertificateAuthorizer
} from "../src/ingress/mtls-tunnel.mjs";

const nodeId = "30000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);

test("mTLS tunnel URL accepts only an HTTPS origin", () => {
  assert.deepEqual(parseTunnelUrl("https://gateway.example.test"), { host: "gateway.example.test", port: 443 });
  assert.deepEqual(parseTunnelUrl("https://gateway.example.test:9443"), { host: "gateway.example.test", port: 9443 });
  for (const value of [
    "http://gateway.example.test",
    "https://user:pass@gateway.example.test",
    "https://gateway.example.test/tunnel",
    "https://gateway.example.test/?token=secret",
    "not-a-url"
  ]) assert.throws(() => parseTunnelUrl(value));
});

test("gateway accepts only a TLS-authorized peer with node UUID CN and negotiated ALPN", () => {
  const socket = {
    authorized: true,
    alpnProtocol: GATEWAY_ALPN,
    getPeerCertificate: () => ({
      fingerprint256: fingerprint.match(/.{2}/g).join(":"),
      serialNumber: "01AB",
      subject: { CN: nodeId }
    })
  };
  assert.deepEqual(getTunnelPeerIdentity(socket), { nodeId, fingerprintSha256: fingerprint, serialNumber: "01AB" });
  assert.throws(() => getTunnelPeerIdentity({ ...socket, authorized: false }));
  assert.throws(() => getTunnelPeerIdentity({ ...socket, alpnProtocol: "http/1.1" }));
  assert.throws(() => getTunnelPeerIdentity({ ...socket, getPeerCertificate: () => ({ fingerprint256: "bad", subject: { CN: "not-a-node" } }) }));
});

test("gateway certificate authorizer uses only fingerprint and node ID against the database function", async () => {
  const calls = [];
  const authorize = createTunnelCertificateAuthorizer({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ authorized: true }] };
    }
  });
  assert.equal(await authorize({ fingerprintSha256: fingerprint, nodeId }), true);
  assert.deepEqual(calls[0].values, [fingerprint, nodeId]);
  assert.match(calls[0].sql, /authorize_node_tunnel_certificate/);
  assert.equal(await authorize({ fingerprintSha256: "invalid", nodeId }), false);
  assert.equal(calls.length, 1);
});

test("gateway tunnel listener enforces TLS 1.3, client certificates and the private ALPN", () => {
  let options;
  const fakeServer = new EventEmitter();
  const server = createNodeTunnelServer({
    tlsOptions: { key: "private", cert: "public", ca: "client-ca" },
    authorizeCertificate: async () => true,
    createServer(config) { options = config; return fakeServer; }
  });
  assert.equal(server, fakeServer);
  assert.equal(server.maxConnections, 1000);
  assert.equal(options.requestCert, true);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.minVersion, "TLSv1.3");
  assert.equal(options.handshakeTimeout, 10000);
  assert.deepEqual(options.ALPNProtocols, [GATEWAY_ALPN]);
  assert.throws(() => createNodeTunnelServer({ tlsOptions: {}, authorizeCertificate: async () => true }));
});

test("gateway closes an established tunnel after certificate authorization is revoked", async () => {
  let connectionHandler;
  let authorizationCalls = 0;
  class FakeServer extends EventEmitter {}
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.authorized = true;
      this.alpnProtocol = GATEWAY_ALPN;
      this.destroyed = false;
      this.writes = [];
    }
    getPeerCertificate() {
      return {
        fingerprint256: fingerprint.match(/.{2}/g).join(":"),
        serialNumber: "01AB",
        subject: { CN: nodeId }
      };
    }
    write(frame) { this.writes.push(JSON.parse(String(frame))); return true; }
    end() { this.destroyed = true; this.emit("close"); }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  const fakeServer = new FakeServer();
  createNodeTunnelServer({
    tlsOptions: { key: "private", cert: "public", ca: "client-ca" },
    authorizeCertificate: async () => ++authorizationCalls === 1,
    authorizationRecheckMs: 1000,
    pingIntervalMs: 10000,
    createServer(_options, callback) {
      connectionHandler = callback;
      return fakeServer;
    }
  });
  const socket = new FakeSocket();
  connectionHandler(socket);
  socket.emit("data", Buffer.from(JSON.stringify({ type: "hello", protocol: 1, node_id: nodeId }) + "\n"));
  const waitFor = async (predicate) => {
    for (let i = 0; i < 150; i += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for gateway certificate revocation.");
  };
  await waitFor(() => socket.writes.some((message) => message.type === "welcome"));
  await waitFor(() => socket.destroyed);
  assert.ok(socket.writes.some((message) => message.type === "error" && message.code === "NODE_TUNNEL_REVOKED"));
  assert.ok(authorizationCalls >= 2);
});

test("gateway replaces an older session when the same node reconnects", async () => {
  let connectionHandler;
  class FakeServer extends EventEmitter {}
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.authorized = true; this.alpnProtocol = GATEWAY_ALPN; this.destroyed = false; this.writes = []; }
    getPeerCertificate() {
      return { fingerprint256: fingerprint.match(/.{2}/g).join(":"), serialNumber: "01AB", subject: { CN: nodeId } };
    }
    write(frame) { this.writes.push(JSON.parse(String(frame))); return true; }
    end() { this.destroyed = true; this.emit("close"); }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  createNodeTunnelServer({
    tlsOptions: { key: "private", cert: "public", ca: "client-ca" },
    authorizeCertificate: async () => true,
    createServer(_options, callback) { connectionHandler = callback; return new FakeServer(); }
  });
  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("Timed out waiting for node tunnel replacement.");
  };
  const first = new FakeSocket();
  connectionHandler(first);
  first.emit("data", Buffer.from(JSON.stringify({ type: "hello", protocol: 1, node_id: nodeId }) + "\n"));
  await waitFor(() => first.writes.some((message) => message.type === "welcome"));

  const second = new FakeSocket();
  connectionHandler(second);
  second.emit("data", Buffer.from(JSON.stringify({ type: "hello", protocol: 1, node_id: nodeId }) + "\n"));
  await waitFor(() => second.writes.some((message) => message.type === "welcome") && first.destroyed);
});

test("node tunnel reconnects after a dropped transport and stops cleanly", async () => {
  const sockets = [];
  const states = [];
  class FakeSocket extends EventEmitter {
    constructor(options) { super(); this.options = options; this.authorized = true; this.alpnProtocol = AGENT_ALPN; this.writes = []; this.destroyed = false; }
    write(frame) { this.writes.push(JSON.parse(String(frame))); return true; }
    destroy(error) { this.destroyed = true; if (error) this.emit("error", error); this.emit("close"); }
  }
  const controller = new AbortController();
  const tunnel = startNodeTunnel({
    nodeId,
    gatewayUrl: "https://gateway.example.test",
    credentials: { cert: "cert", key: "key", ca: "ca" },
    signal: controller.signal,
    minBackoffMs: 1,
    maxBackoffMs: 1,
    random: () => 0.5,
    sleepImpl: async () => new Promise((resolve) => setTimeout(resolve, 2)),
    onState: (state) => states.push(state),
    connectImpl(options) {
      const socket = new FakeSocket(options);
      sockets.push(socket);
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket;
    }
  });

  const waitFor = async (predicate) => {
    for (let i = 0; i < 100; i += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error("Timed out waiting for tunnel test condition.");
  };

  await waitFor(() => sockets.length === 1 && sockets[0].writes.some((m) => m.type === "hello"));
  assert.deepEqual(sockets[0].writes[0], { type: "hello", protocol: 1, node_id: nodeId });
  sockets[0].emit("data", Buffer.from(JSON.stringify({ type: "welcome", protocol: 1 }) + "\n"));
  sockets[0].emit("data", Buffer.from(JSON.stringify({ type: "ping", sequence: 1 }) + "\n"));
  assert.deepEqual(sockets[0].writes[1], { type: "pong", sequence: 1 });
  sockets[0].emit("close");

  await waitFor(() => sockets.length >= 2);
  controller.abort();
  await tunnel.done;
  assert.ok(states.includes("connected"));
  assert.ok(states.includes("stopped"));
});

test("node tunnel stops retrying when the gateway rejects its certificate identity", async () => {
  const states = [];
  const controller = new AbortController();
  const tunnel = startNodeTunnel({
    nodeId,
    gatewayUrl: "https://gateway.example.test",
    credentials: { cert: "cert", key: "key", ca: "ca" },
    signal: controller.signal,
    onState: (state) => states.push(state),
    connectImpl() {
      const socket = new EventEmitter();
      socket.authorized = true;
      socket.alpnProtocol = AGENT_ALPN;
      socket.write = () => true;
      socket.destroy = (error) => { if (error) socket.emit("error", error); socket.emit("close"); };
      queueMicrotask(() => {
        socket.emit("secureConnect");
        socket.emit("data", Buffer.from(JSON.stringify({ type: "error", code: "NODE_TUNNEL_REVOKED" }) + "\n"));
      });
      return socket;
    }
  });
  await tunnel.done;
  assert.ok(states.includes("rejected"));
  assert.ok(states.includes("stopped"));
  controller.abort();
});

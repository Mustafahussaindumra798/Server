#!/usr/bin/env node
import { lstatSync, readFileSync } from "node:fs";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { createDatabasePool } from "./src/db/pool.mjs";
import { createNodeTunnelServer, createTunnelCertificateAuthorizer } from "./src/ingress/mtls-tunnel.mjs";
import { createRouteStreamManager } from "./src/ingress/route-streams.mjs";
import { createRouteGrantSigner } from "./src/ingress/route-grants.mjs";
import { createIngressRequestHandler } from "./src/ingress/http-proxy.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required.");
  return value;
}

function readTlsFile(name, { privateKey = false } = {}) {
  const filePath = required(name);
  const info = lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(name + " must reference a regular file, not a symlink.");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error(name + " must be owned by the gateway service user.");
  if (privateKey && (info.mode & 0o077) !== 0) throw new Error(name + " permissions must be 0600 or stricter.");
  if (info.size > 128 * 1024) throw new Error(name + " exceeds the allowed 128 KiB size.");
  return readFileSync(filePath);
}

function listenAddress(value) {
  const version = isIP(value);
  const loopback = value === "127.0.0.1" || value === "::1";
  const privateV4 = version === 4 && (() => {
    const [a, b] = value.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 127);
  })();
  const privateV6 = version === 6 && (/^(fc|fd)/i.test(value) || /^fe[89ab]/i.test(value));
  if (!value || version === 0 || (!loopback && !privateV4 && !privateV6)) {
    throw new Error("CLOUDEXIFY_TUNNEL_LISTEN_HOST must be loopback or a private/link-local interface IP; public and wildcard binds are forbidden.");
  }
  return value;
}

async function main() {
  const host = listenAddress(process.env.CLOUDEXIFY_TUNNEL_LISTEN_HOST || "127.0.0.1");
  const port = Number(process.env.CLOUDEXIFY_TUNNEL_LISTEN_PORT || 9443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("CLOUDEXIFY_TUNNEL_LISTEN_PORT must be between 1 and 65535.");
  const pool = createDatabasePool(required("DATABASE_URL"), { max: 10, queryTimeoutMillis: 5000 });
  const routeStreams = createRouteStreamManager();
  const server = createNodeTunnelServer({
    tlsOptions: {
      key: readTlsFile("CLOUDEXIFY_TUNNEL_SERVER_KEY", { privateKey: true }),
      cert: readTlsFile("CLOUDEXIFY_TUNNEL_SERVER_CERT"),
      ca: readTlsFile("CLOUDEXIFY_TUNNEL_CLIENT_CA")
    },
    authorizeCertificate: createTunnelCertificateAuthorizer(pool),
    onConnection: ({ nodeId, socket }) => {
      routeStreams.attachNode({ nodeId, socket });
      process.stdout.write(JSON.stringify({
        timestamp: new Date().toISOString(), event: "node_tunnel_authenticated", node_id: nodeId
      }) + "\n");
    },
    onDisconnect: ({ nodeId }) => routeStreams.detachNode(nodeId),
    onRouteMessage: ({ nodeId, message }) => routeStreams.handleNodeMessage(nodeId, message)
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "node_tunnel_gateway_started",
    listen_host: host,
    listen_port: port,
    protocol: "mTLS/TLS1.3",
    route_streams_enabled: true,
    public_ingress_enabled: process.env.CLOUDEXIFY_PUBLIC_INGRESS_ENABLED === "true"
  }) + "\n");

  let ingressServer = null;
  if (process.env.CLOUDEXIFY_PUBLIC_INGRESS_ENABLED === "true") {
    const ingressPort = Number(process.env.CLOUDEXIFY_INGRESS_LISTEN_PORT || 443);
    const ingressHost = process.env.CLOUDEXIFY_INGRESS_LISTEN_HOST || "0.0.0.0";
    if (!Number.isInteger(ingressPort) || ingressPort < 1 || ingressPort > 65535) {
      throw new Error("CLOUDEXIFY_INGRESS_LISTEN_PORT must be between 1 and 65535.");
    }
    const ingressCertificate = readTlsFile("CLOUDEXIFY_INGRESS_TLS_CERT");
    const ingressKey = readTlsFile("CLOUDEXIFY_INGRESS_TLS_KEY", { privateKey: true });
    const parsedCertificate = new X509Certificate(ingressCertificate);
    const now = Date.now();
    if (Date.parse(parsedCertificate.validFrom) > now || Date.parse(parsedCertificate.validTo) <= now) {
      throw new Error("Ingress TLS certificate is not currently valid.");
    }
    const privateGrantKey = required("CLOUDEXIFY_ROUTE_GRANT_PRIVATE_KEY");
    const signRouteGrant = createRouteGrantSigner(privateGrantKey);
    const handler = createIngressRequestHandler({
      pool,
      routeStreams,
      signRouteGrant,
      certificate: parsedCertificate,
      logger: (event, fields) => process.stderr.write(JSON.stringify({
        timestamp: new Date().toISOString(), level: "warn", event, ...fields
      }) + "\\n")
    });
    ingressServer = https.createServer({
      key: ingressKey,
      cert: ingressCertificate,
      minVersion: "TLSv1.3",
      maxHeaderSize: 16 * 1024,
      requestTimeout: 60000,
      headersTimeout: 10000,
      keepAliveTimeout: 5000
    }, (request, response) => { void handler(request, response); });
    ingressServer.maxConnections = 1000;
    try {
      await new Promise((resolve, reject) => {
        ingressServer.once("error", reject);
        ingressServer.listen(ingressPort, ingressHost, resolve);
      });
    } catch (error) {
      server.close(() => { void pool.end(); });
      throw error;
    }
    process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "public_https_ingress_started",
      listen_host: ingressHost,
      listen_port: ingressPort,
      protocol: "HTTPS/TLS1.3",
      hostname_routes: "active_routes_only"
    }) + "\\n");
  }

  const shutdown = () => {
    ingressServer?.close();
    routeStreams.closeAll();
    server.close(() => { void pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ level: "error", event: "node_tunnel_gateway_failed", message: error.message }) + "\n");
  process.exitCode = 1;
});

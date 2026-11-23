#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { createDatabasePool } from "./src/db/pool.mjs";
import { createNodeTunnelServer, createTunnelCertificateAuthorizer } from "./src/ingress/mtls-tunnel.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required.");
  return value;
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
  const pool = createDatabasePool(required("DATABASE_URL"), { max: 5 });
  const server = createNodeTunnelServer({
    tlsOptions: {
      key: readFileSync(required("CLOUDEXIFY_TUNNEL_SERVER_KEY")),
      cert: readFileSync(required("CLOUDEXIFY_TUNNEL_SERVER_CERT")),
      ca: readFileSync(required("CLOUDEXIFY_TUNNEL_CLIENT_CA"))
    },
    authorizeCertificate: createTunnelCertificateAuthorizer(pool),
    onConnection: ({ nodeId }) => process.stdout.write(JSON.stringify({
      timestamp: new Date().toISOString(), event: "node_tunnel_authenticated", node_id: nodeId
    }) + "\n")
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
    forwarding_enabled: false
  }) + "\n");

  const shutdown = () => {
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

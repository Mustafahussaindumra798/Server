# Cloudexify Server

**Code Your Future** — a multi-device hosting control-plane prototype.

## Current status
This repository currently contains a static dashboard and a small Node.js development server. The dashboard uses in-memory sample data only. It does not connect to devices, deploy containers, create tunnels, or host customer workloads.

## Run locally
Requires Node.js 20 or newer.

```bash
node server.mjs
```

Open http://127.0.0.1:4173. Set `PORT` or `HOST` to override the defaults.

Health check: `GET /api/health`.

## Prototype interactions
- Browse the overview, nodes, applications, deployments, network, activity and settings navigation.
- Register a sample node using the modal. This changes only browser memory.
- Dismiss the simulation notice.
- Refreshing the page resets sample data.

## Architecture direction
See [docs/architecture.md](docs/architecture.md) and [docs/roadmap.md](docs/roadmap.md). Real node enrollment, authentication, scheduling, deployments, networking and persistence are not implemented yet.

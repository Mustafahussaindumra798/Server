# Android / Termux node enrollment

This is a best-effort diagnostic agent for Android devices running Termux. It reports metrics and receives only the allowlisted non-mutating diagnostic jobs. It is not a general Android hosting runtime.

## 1. Create a one-time token

1. Sign in to the Cloudexify Server dashboard as a tenant Owner or Admin.
2. Open **Compute nodes**.
3. Select **Create enrollment token**.
4. Copy the token immediately. It is shown only once and expires after 30 minutes.

Do not paste the token into a public chat, issue, source file or shared terminal recording.

## 2. Prepare Termux

Install Termux from a trusted distribution source. In Termux:

```sh
pkg update
pkg install nodejs-lts git
node --version
npm --version
```

Node.js 20 or newer is required.

## 3. Download the agent

```sh
git clone https://github.com/danyalbut96-khan/Server.git
cd Server
npm install
```

## 4. Enroll this device

Use the exact HTTPS origin where your Cloudexify dashboard is deployed (no trailing slash). Do not use a preview URL unless its API is configured for the same Supabase project.

```sh
export CLOUDEXIFY_CONTROL_PLANE_URL="https://YOUR-CONTROL-PLANE-DOMAIN"
export CLOUDEXIFY_NODE_NAME="android-termux-phone"
read -s -p "One-time enrollment token: " CLOUDEXIFY_ENROLLMENT_TOKEN
echo
export CLOUDEXIFY_ENROLLMENT_TOKEN
npm run agent -- enroll
unset CLOUDEXIFY_ENROLLMENT_TOKEN
```

Enrollment saves the node credential under Termux's private home directory at `~/.local/share/cloudexify-agent/node.json`. The agent creates this directory with owner-only permissions and stores the credential file with mode `0600`. Do not copy or share this file.

## 5. Approve and start the agent

Return to **Compute nodes** in the dashboard and refresh. The new device should appear as **pending**. An Owner/Admin must approve it.

In the same Termux session:

```sh
npm run agent -- run
```

Keep Termux running. Android battery optimization or background-process restrictions may stop long-running processes; for initial qualification, keep Termux in the foreground and the phone awake.

## 6. Verify real device data

- Dashboard node status changes to **online** after a successful heartbeat following approval.
- CPU, memory, storage and uptime appear only when the Android environment exposes those metrics.
- Battery and temperature are optional and may be absent on some Android devices.
- Stop the agent with `Ctrl+C`. After three missed heartbeat intervals (default: 60 seconds each), refresh the dashboard and confirm it reports **offline**.
- Start it again with `npm run agent -- run` and confirm it returns to **online**.

## Troubleshooting

- **HTTP 401/403:** token or node credential is invalid, expired or revoked; create a fresh enrollment token and enroll again if the node was not already registered.
- **HTTP 404:** verify the control-plane domain and that the deployment includes the current API.
- **Node remains pending:** approve it in the dashboard; heartbeat does not auto-approve nodes.
- **Node goes offline in background:** Android may have suspended Termux. Disable battery optimization for Termux only if you understand the battery impact, or keep the app foregrounded during testing.
- **Missing battery/temperature:** optional OS interfaces are not exposed consistently across Android vendors.

Never run arbitrary shell jobs from the control plane. This agent currently supports only `probe` and `collect_metrics`.

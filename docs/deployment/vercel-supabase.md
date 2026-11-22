# Vercel + Supabase deployment guide

**Purpose:** Deploy the existing dashboard as static files and expose the existing Node.js control-plane API as Vercel Functions, while keeping PostgreSQL in Supabase. This is the deployment foundation; it does not convert the dashboard's current sample data into live database data.

## 1. Vercel project configuration

Import `https://github.com/danyalbut96-khan/Server` into Vercel.

Use these project settings:

| Setting | Value |
|---|---|
| Framework Preset | Other |
| Root Directory | `./` (repository root) |
| Build Command | Leave empty |
| Output Directory | Leave empty |
| Install Command | `npm install` (or Vercel default) |
| Production Branch | `main` |

The repository root is intentional: `index.html`, `app.js`, and `styles.css` are currently at the root. Vercel serves them as static assets. The `api/` directory contains Node.js Functions.

After deployment, the dashboard is served at `/`, and the API health endpoint is `/api/health`.

## 2. Supabase database setup

Create a Supabase project and open **SQL Editor**.

Run the existing schema migrations in this exact order. Open each file in GitHub, copy its complete SQL, paste it into a new SQL Editor query, and run it once:

1. [001_initial_schema.sql](../../database/migrations/001_initial_schema.sql)
2. [002_auth_identity_context.sql](../../database/migrations/002_auth_identity_context.sql)
3. [003_node_enrollment.sql](../../database/migrations/003_node_enrollment.sql)
4. [004_node_heartbeat.sql](../../database/migrations/004_node_heartbeat.sql)
5. [005_safe_node_jobs.sql](../../database/migrations/005_safe_node_jobs.sql)

Do not rerun these migrations on a database where they have already succeeded. They are schema migrations, not repeatable seed scripts.

### Create the restricted API database role

After all five migrations succeed:

1. Open [001_runtime_role.sql](../../supabase/setup/001_runtime_role.sql).
2. Replace `REPLACE_WITH_A_LONG_RANDOM_PASSWORD` with a unique password before running it.
3. Run the complete SQL once in Supabase SQL Editor.
4. Confirm the final query returns `rolsuper = false`, `rolbypassrls = false`, `rolcreatedb = false`, and `rolcreaterole = false`.

The API role is intentionally not the Supabase `postgres` owner role. Do not connect the deployed application as `postgres`.

## 3. Supabase connection string

In Supabase, open **Connect → Transaction pooler** and copy the connection string. Use the transaction pooler (port `6543`) for Vercel serverless functions.

Change the username portion to the role created above. The expected shape is:

```text
postgresql://cloudexify_runtime.PROJECT_REF:URL_ENCODED_PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres?sslmode=require
```

Use the exact host and region shown by your Supabase Connect panel; do not guess them. URL-encode reserved characters in the password (for example `@`, `#`, `/`, `?`, and spaces). Keep `sslmode=require`.

## 4. Vercel environment variables

In **Vercel → Project → Settings → Environment Variables**, add the following for Production and Preview as appropriate.

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | Yes for database-backed API | Supabase Transaction Pooler URL using `cloudexify_runtime` |
| `DB_POOL_MAX` | Recommended | `1` |
| `CORS_ORIGINS` | Yes for browser requests that send an Origin header | Exact Vercel production origin and custom dashboard origin, comma-separated, no trailing slash |
| `OIDC_ISSUER` | Required for user-authenticated API routes | Exact issuer URL from the selected OIDC provider |
| `OIDC_AUDIENCE` | Required for user-authenticated API routes | API audience configured in that provider |
| `OIDC_JWKS_URI` | Required for user-authenticated API routes | HTTPS JWKS endpoint from that provider |

Example CORS value:

```text
https://YOUR-PROJECT.vercel.app,https://control.cloudexify.site
```

Do not add Supabase `service_role`, secret API keys, database passwords, or OIDC client secrets to frontend variables such as `VITE_*` or `NEXT_PUBLIC_*`. This dashboard uses the server-side PostgreSQL API path; it does not need a Supabase browser key.

The OIDC provider has not yet been selected/configured in this repository. Until the three OIDC values are supplied and an owner identity is provisioned, user-authenticated `/api/v1` routes intentionally return a configuration error. The public `/api/health` endpoint only verifies API/database connectivity.

## 5. Local environment

For local API testing, copy `.env.example` to `.env`, fill in the values, and run:

```bash
npm install
npm start
```

Open `http://127.0.0.1:4173`. Never commit `.env`.

## 6. Deployment verification

After Vercel reports the deployment as Ready, test:

- `https://YOUR-PROJECT.vercel.app/` — dashboard static page loads.
- `https://YOUR-PROJECT.vercel.app/api/health` — should return HTTP 200 and `{"status":"ok","database":"connected",...}` after database setup and environment configuration.
- If health returns `not_configured`, `DATABASE_URL` is missing from the selected Vercel environment.
- If health returns `degraded`, verify the pooler host, username, password, SSL mode and Supabase project status.

The current dashboard still displays demo/sample inventory and simulated actions. Real node/application inventory, live dashboard queries, OIDC login UI, first-owner bootstrap and live event updates are separate integration work and must not be mistaken for completed deployment functionality.

## 7. Current architecture boundary

- Vercel: static dashboard and serverless Node.js API.
- Supabase: PostgreSQL persistence only for this first deployment foundation.
- Compute nodes: remain separate devices; they do not host the control dashboard or API.
- The API and database must remain reachable independently of the application-hosting node pool.

## Security notes

- Use the restricted `cloudexify_runtime` role, not the database owner.
- Keep all secrets in Vercel server-side environment variables.
- Do not enable public Data API access for the internal control-plane tables as part of this deployment.
- Back up the Supabase project before applying migrations.
- Do not enroll production nodes until the API identity/bootstrap and node approval workflow has been configured.


## Supabase Auth and live dashboard

Add the following Vercel environment variables to Production (and Preview if you test preview deployments):

- `SUPABASE_URL` — your existing Supabase project URL.
- `SUPABASE_PUBLISHABLE_KEY` — the publishable key. For legacy projects, `SUPABASE_ANON_KEY` is accepted instead.

Do not add a Supabase secret/service-role key to the browser. The dashboard receives only the public publishable/anon key through `/api/config`. The API validates each user access token against the project's Supabase Auth `/auth/v1/user` endpoint before resolving the existing Cloudexify database identity.

The first Cloudexify Owner must exist in Supabase Authentication and be provisioned in `public.users` and `public.tenant_memberships`. Follow [Supabase Auth and tenant RBAC](../authentication-rbac.md) for the exact identity mapping and provisioning template. Do not rerun migrations 001–005 or the runtime-role creation SQL; the dashboard integration does not require them to be rerun.

The dashboard loads nodes, applications, deployments and jobs through tenant-protected API routes and refreshes every 15 seconds. It intentionally does not expose internal database tables directly to browser Realtime subscriptions because the current RLS policies rely on transaction-local `app.user_id`. A separate Realtime authorization bridge can be designed later without weakening tenant isolation.

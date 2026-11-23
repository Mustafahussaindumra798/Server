#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must point to the disposable CI PostgreSQL database}"
tenant_id="21000000-0000-4000-8000-000000000001"
node_id="31000000-0000-4000-8000-000000000001"
job_a="61000000-0000-4000-8000-000000000001"
job_b="61000000-0000-4000-8000-000000000002"
credential_hash="$(printf 'c%.0s' {1..64})"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"; psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DELETE FROM public.tenants WHERE id = '\''$tenant_id'\'';" >/dev/null' EXIT
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO public.tenants (id,name,slug) VALUES ('$tenant_id','Concurrent Claim Integration','concurrent-claim-integration');
INSERT INTO public.nodes (id,tenant_id,name,platform,architecture,status,approved_at,last_seen_at)
VALUES ('$node_id','$tenant_id','concurrent-claim-node','linux','x86_64','online',clock_timestamp(),clock_timestamp());
INSERT INTO public.node_credentials (node_id,secret_hash) VALUES ('$node_id','$credential_hash');
INSERT INTO public.jobs (id,tenant_id,node_id,type,payload_json,idempotency_key)
VALUES ('$job_a','$tenant_id','$node_id','probe','{}'::jsonb,'concurrent-claim-a'),
       ('$job_b','$tenant_id','$node_id','probe','{}'::jsonb,'concurrent-claim-b');
SQL
psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "BEGIN; SELECT job_id FROM app_private.claim_node_jobs('$node_id','$credential_hash',1,60); SELECT pg_sleep(2); COMMIT;" \
  >"$tmp_dir/session-a.out" &
session_a_pid=$!
sleep 0.3
psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "SELECT job_id FROM app_private.claim_node_jobs('$node_id','$credential_hash',1,60);" \
  >"$tmp_dir/session-b.out"
wait "$session_a_pid"
claimed_a="$(grep -E '^[0-9a-f-]{36}$' "$tmp_dir/session-a.out" | head -n 1 || true)"
claimed_b="$(grep -E '^[0-9a-f-]{36}$' "$tmp_dir/session-b.out" | head -n 1 || true)"
if [[ -z "$claimed_a" || -z "$claimed_b" || "$claimed_a" == "$claimed_b" ]]; then
  echo "Concurrent sessions did not claim two distinct jobs" >&2
  cat "$tmp_dir/session-a.out" "$tmp_dir/session-b.out" >&2
  exit 1
fi
echo "Concurrent claim integration passed: $claimed_a and $claimed_b"

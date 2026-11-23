BEGIN;

-- Resource requests are explicit reservations. They do not imply that a
-- workload has been started; runtime execution remains disabled.
ALTER TABLE public.applications
  ADD COLUMN resource_requests_json jsonb NOT NULL DEFAULT
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'::jsonb
    CHECK (jsonb_typeof(resource_requests_json) = 'object')
    CHECK (
      (resource_requests_json->>'cpu_millicores') ~ '^[0-9]+$'
      AND (resource_requests_json->>'cpu_millicores')::bigint BETWEEN 50 AND 64000
      AND (resource_requests_json->>'memory_bytes') ~ '^[0-9]+$'
      AND (resource_requests_json->>'memory_bytes')::bigint BETWEEN 16777216 AND 1099511627776
      AND (resource_requests_json->>'disk_bytes') ~ '^[0-9]+$'
      AND (resource_requests_json->>'disk_bytes')::bigint BETWEEN 16777216 AND 1099511627776
    );

ALTER TABLE public.deployments
  ADD COLUMN resource_requests_json jsonb NOT NULL DEFAULT
    '{"cpu_millicores":250,"memory_bytes":268435456,"disk_bytes":1073741824}'::jsonb
    CHECK (jsonb_typeof(resource_requests_json) = 'object')
    CHECK (
      (resource_requests_json->>'cpu_millicores') ~ '^[0-9]+$'
      AND (resource_requests_json->>'cpu_millicores')::bigint BETWEEN 50 AND 64000
      AND (resource_requests_json->>'memory_bytes') ~ '^[0-9]+$'
      AND (resource_requests_json->>'memory_bytes')::bigint BETWEEN 16777216 AND 1099511627776
      AND (resource_requests_json->>'disk_bytes') ~ '^[0-9]+$'
      AND (resource_requests_json->>'disk_bytes')::bigint BETWEEN 16777216 AND 1099511627776
    );

CREATE INDEX deployments_node_reservations_idx
  ON public.deployments (target_node_id, status)
  WHERE desired_state = 'running'
    AND status IN ('queued','scheduled','deploying','healthy');

COMMIT;

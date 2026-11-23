BEGIN;

-- Operator-controlled ingress admission state. Draining blocks new route
-- lookups and grants while preserving the active route/version so requests
-- already in flight can complete and pass periodic revalidation.
ALTER TABLE public.nodes
  ADD COLUMN ingress_draining boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.nodes.ingress_draining IS
  'When true, the ingress gateway stops admitting new route streams and drains existing streams. Does not change deployment or route eligibility.';


COMMIT;

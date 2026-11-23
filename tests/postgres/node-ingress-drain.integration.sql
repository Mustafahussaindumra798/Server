DO $test$
DECLARE
  v_not_null boolean;
  v_default text;
BEGIN
  SELECT attribute.attnotnull, pg_get_expr(default_value.adbin, default_value.adrelid)
    INTO v_not_null, v_default
    FROM pg_attribute AS attribute
    LEFT JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
   WHERE attribute.attrelid = 'public.nodes'::regclass
     AND attribute.attname = 'ingress_draining'
     AND NOT attribute.attisdropped;

  IF NOT FOUND OR v_not_null IS DISTINCT FROM true OR v_default IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'nodes.ingress_draining must be NOT NULL with a false default';
  END IF;

  IF to_regclass('public.nodes_ingress_draining_idx') IS NULL THEN
    RAISE EXCEPTION 'nodes_ingress_draining_idx is missing';
  END IF;
END
$test$;

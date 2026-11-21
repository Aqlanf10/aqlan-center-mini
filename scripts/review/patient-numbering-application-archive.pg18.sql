-- Companion for disposable app-archive restore verification, never a migration.
BEGIN;
DO $$
BEGIN
  IF current_database() !~ '^aqlan_numbering_review_[0-9a-f]{32}$'
      OR to_regprocedure('numbering_review.frozen_recovery_state()') IS NULL THEN
    RAISE EXCEPTION 'application archive adapter is synthetic-only';
  END IF;
END; $$;
SET LOCAL ROLE aqlan_numbering_data_owner;

CREATE FUNCTION numbering_review.prepare_application_archive_fixture(expected jsonb, approved_target text)
RETURNS bigint LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target text; source_binding text; archived_ordinal bigint; consumed boolean;
  runtime_state numbering_review.policy%ROWTYPE;
  ordinal_before bigint; called_before boolean; actual_map text;
BEGIN
  IF current_database() !~ '^aqlan_numbering_review_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'application archive adapter is synthetic-only';
  END IF;
  LOCK TABLE public.patients IN ACCESS EXCLUSIVE MODE;
  PERFORM numbering_review.assert_runtime_fenced();
  target := numbering_review.local_database_binding();
  source_binding := expected->>'binding';
  IF target IS NULL OR approved_target IS DISTINCT FROM target OR source_binding IS NULL
     OR source_binding = target OR source_binding !~ '^[0-9]{1,20}:[0-9]{1,10}$'
     OR expected->>'prefix' IS NULL OR expected->>'prefix' COLLATE "C" !~ '^[A-Z]{1,6}$'
     OR expected->>'lastValue' IS NULL OR expected->>'lastValue' !~ '^[1-9][0-9]{0,18}$'
     OR expected->>'revision' IS NULL OR expected->>'revision' !~ '^[1-9][0-9]{0,18}$'
     OR jsonb_typeof(expected->'isCalled') IS DISTINCT FROM 'boolean'
     OR expected->>'syntheticNumberMapSha256' IS NULL THEN
    RAISE EXCEPTION 'incomplete or wrong-target archive witness' USING ERRCODE = '55000';
  END IF;
  archived_ordinal := (expected->>'lastValue')::bigint;
  consumed := (expected->>'isCalled')::boolean;
  IF archived_ordinal < 7000 OR (expected->>'revision')::bigint < 3 THEN
    RAISE EXCEPTION 'invalid archive witness' USING ERRCODE = '55000';
  END IF;
  SELECT p.* INTO STRICT runtime_state FROM numbering_review.policy p WHERE p.singleton FOR UPDATE;
  IF runtime_state.phase <> 'LEGACY' OR runtime_state.revision <> 1 OR runtime_state.prefix <> 'P'
     OR runtime_state.database_binding IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'target already has numbering state' USING ERRCODE = '55000';
  END IF;
  SELECT encode(sha256(convert_to(
    coalesce(jsonb_agg(jsonb_build_array(id, patient_number) ORDER BY id)::text, '[]'), 'UTF8'
  )), 'hex') INTO actual_map FROM public.patients;
  IF expected->>'syntheticNumberMapSha256' IS DISTINCT FROM actual_map THEN
    RAISE EXCEPTION 'restored file identity map differs from archive witness' USING ERRCODE = '55000';
  END IF;

  ALTER SEQUENCE public.patient_number_seq CACHE 1;
  SELECT last_value,is_called INTO STRICT ordinal_before,called_before FROM public.patient_number_seq;
  -- Exact, pristine migration-only target; app bootstrap/previous issuance is refused.
  IF ordinal_before <> 1 OR NOT called_before THEN
    RAISE EXCEPTION 'archive target counter must be pristine' USING ERRCODE = '55000';
  END IF;
  EXECUTE format('ALTER SEQUENCE public.patient_number_seq RESTART WITH %s', archived_ordinal);
  -- The fresh transactional restart gives an isolated sequence version. To
  -- preserve a *consumed* value, burn it there; do not use nontransactional setval.
  IF consumed AND nextval('public.patient_number_seq'::regclass) <> archived_ordinal THEN
    RAISE EXCEPTION 'sequence reconstruction failed' USING ERRCODE = '55000';
  END IF;
  UPDATE numbering_review.policy
    SET phase = 'RECOVERY_HOLD', database_binding = source_binding,
        prefix = expected->>'prefix', revision = (expected->>'revision')::bigint
    WHERE singleton;
  IF numbering_review.frozen_recovery_state() IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'reconstructed archive evidence differs' USING ERRCODE = '55000';
  END IF;
  RETURN (expected->>'revision')::bigint;
END; $$;
REVOKE ALL ON FUNCTION numbering_review.prepare_application_archive_fixture(jsonb,text) FROM PUBLIC;
COMMIT;

-- Verification-only companion to patient-numbering-fence.pg18.sql.
-- Explicit source and target proof are required; no archive or application can run this.
BEGIN;
DO $$
BEGIN
  IF current_database() !~ '^aqlan_numbering_review_[0-9a-f]{32}$'
     OR to_regprocedure('numbering_review.assert_runtime_fenced()') IS NULL THEN
    RAISE EXCEPTION 'numbering recovery is for installed synthetic review fixtures only';
  END IF;
END; $$;
SET LOCAL ROLE aqlan_numbering_data_owner;

CREATE FUNCTION numbering_review.frozen_recovery_state() RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  -- Acquisition order matches cutover/hold. The read touches only isolated synthetic rows.
  LOCK TABLE public.patients IN ACCESS EXCLUSIVE MODE;
  PERFORM numbering_review.assert_runtime_fenced();
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.patients'::regclass AND t.tgname = 'numbering_review_boundary'
      AND t.tgenabled = 'A' AND NOT t.tgisinternal AND t.tgtype = 23
      AND t.tgattr::text = (SELECT attnum::text FROM pg_attribute
        WHERE attrelid = t.tgrelid AND attname = 'patient_number' AND NOT attisdropped)
      AND t.tgfoid = 'numbering_review.assign_patient_number()'::regprocedure
  ) THEN RAISE EXCEPTION 'missing numbering fence' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_sequence WHERE seqrelid = 'public.patient_number_seq'::regclass
      AND seqincrement = 1 AND seqcache = 1 AND NOT seqcycle AND seqmin = 1
  ) THEN RAISE EXCEPTION 'incompatible sequence' USING ERRCODE = '55000';
  END IF;

  -- Serialize any pending sequence operations without changing its logical position.
  ALTER SEQUENCE public.patient_number_seq CACHE 1;
  SELECT jsonb_build_object(
    'binding', p.database_binding, 'prefix', p.prefix, 'revision', p.revision::text,
    'lastValue', s.last_value::text, 'isCalled', s.is_called,
    'syntheticNumberMapSha256', (
      SELECT encode(sha256(convert_to(
        coalesce(jsonb_agg(jsonb_build_array(id, patient_number) ORDER BY id)::text, '[]'), 'UTF8'
      )), 'hex') FROM public.patients
    )
  ) INTO result FROM numbering_review.policy p CROSS JOIN public.patient_number_seq s
    WHERE p.singleton AND p.phase = 'RECOVERY_HOLD';
  IF result IS NULL THEN RAISE EXCEPTION 'source was not held' USING ERRCODE = '55000'; END IF;
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION numbering_review.frozen_recovery_state() FROM PUBLIC;

CREATE FUNCTION numbering_review.capture_recovery_witness() RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  IF current_database() !~ '^aqlan_numbering_review_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'synthetic recovery only';
  END IF;
  result := numbering_review.frozen_recovery_state();
  IF result->>'binding' IS DISTINCT FROM numbering_review.local_database_binding() THEN
    RAISE EXCEPTION 'only the original held source can prepare a witness' USING ERRCODE = '55000';
  END IF;
  RETURN result;
END; $$;
REVOKE ALL ON FUNCTION numbering_review.capture_recovery_witness() FROM PUBLIC;

CREATE FUNCTION numbering_review.resume_approved_fixture(expected jsonb, approved_target text) RETURNS bigint
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE target text; actual jsonb; next_revision bigint;
BEGIN
  IF current_database() !~ '^aqlan_numbering_review_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'synthetic recovery only';
  END IF;
  target := numbering_review.local_database_binding();
  IF target IS NULL OR target IS DISTINCT FROM approved_target THEN
    RAISE EXCEPTION 'approval is not for this target' USING ERRCODE = '55000';
  END IF;
  actual := numbering_review.frozen_recovery_state();
  IF actual IS DISTINCT FROM expected OR target = actual->>'binding' THEN
    RAISE EXCEPTION 'restored state differs from the approved held source' USING ERRCODE = '55000';
  END IF;
  -- Verification binds the copied state to this explicitly approved fixture.
  -- No setval, policy change, role/credential mutation or previous-row rewrite.
  UPDATE numbering_review.policy SET phase = 'MANAGED', database_binding = target, revision = revision + 1
    WHERE singleton RETURNING revision INTO next_revision;
  RETURN next_revision;
END; $$;
-- This is not SECURITY DEFINER and has no GRANT. Only the existing synthetic
-- data owner can execute it with its current DB powers. It is not an app role.
REVOKE ALL ON FUNCTION numbering_review.resume_approved_fixture(jsonb,text) FROM PUBLIC;
COMMIT;

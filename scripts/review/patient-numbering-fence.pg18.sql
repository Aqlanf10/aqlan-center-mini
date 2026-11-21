-- NOT a migration. Deliberately refuses every database outside the synthetic review harness.
-- The old allocator remains the only allocator until an explicit pilot transition.
BEGIN;
DO $$
BEGIN
  IF current_database() !~ '^aqlan_numbering_review_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'numbering review SQL cannot run outside an isolated fixture';
  END IF;
  IF (SELECT relowner FROM pg_class WHERE oid = 'public.patients'::regclass)
       <> 'aqlan_numbering_data_owner'::regrole::oid
     OR (SELECT relowner FROM pg_class WHERE oid = 'public.patient_number_seq'::regclass)
       <> 'aqlan_numbering_data_owner'::regrole::oid
     OR NOT EXISTS (
       SELECT 1 FROM pg_sequence WHERE seqrelid = 'public.patient_number_seq'::regclass
       AND seqincrement = 1 AND seqcache = 1 AND NOT seqcycle AND seqmin = 1
     ) THEN
    RAISE EXCEPTION 'allocator objects must have the expected owner and sequence semantics';
  END IF;
END; $$;

SET LOCAL ROLE aqlan_numbering_data_owner;
CREATE SCHEMA numbering_review AUTHORIZATION aqlan_numbering_data_owner;
REVOKE ALL ON SCHEMA numbering_review FROM PUBLIC;
GRANT USAGE ON SCHEMA numbering_review TO aqlan_numbering_operator;
CREATE TABLE numbering_review.policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  phase text NOT NULL CHECK (phase IN ('LEGACY', 'MANAGED', 'RECOVERY_HOLD')),
  prefix text NOT NULL CHECK (prefix COLLATE "C" ~ '^[A-Z]{1,6}$'),
  revision bigint NOT NULL CHECK (revision > 0),
  database_binding text NOT NULL
);
-- Bind privileged state to the original database. A copied policy is not
-- enrollment/recovery authority on a different cluster or database. Physical
-- clones retaining both native identities still require an external hold.
CREATE FUNCTION numbering_review.local_database_binding() RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.system_identifier::text || ':' || d.oid::text
  FROM pg_control_system() s CROSS JOIN pg_database d WHERE d.datname = current_database()
$$;
REVOKE ALL ON FUNCTION numbering_review.local_database_binding() FROM PUBLIC;
INSERT INTO numbering_review.policy(phase, prefix, revision, database_binding)
  SELECT 'LEGACY', 'P', 1, numbering_review.local_database_binding();

CREATE FUNCTION numbering_review.assign_patient_number() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  policy numbering_review.policy%ROWTYPE;
  ordinal text;
BEGIN
  SELECT p.* INTO STRICT policy FROM numbering_review.policy p WHERE singleton FOR SHARE;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.patient_number IS DISTINCT FROM OLD.patient_number
       AND (policy.phase <> 'LEGACY' OR policy.database_binding IS DISTINCT FROM numbering_review.local_database_binding()) THEN
      RAISE EXCEPTION 'assigned patient numbers are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF policy.phase = 'RECOVERY_HOLD' OR policy.database_binding IS DISTINCT FROM numbering_review.local_database_binding() THEN
    RAISE EXCEPTION 'patient numbering held pending verified recovery' USING ERRCODE = '55000';
  ELSIF policy.phase = 'LEGACY' THEN
    -- No second issuance mechanism while the existing four writers are live.
    IF NEW.patient_number IS NULL THEN
      RAISE EXCEPTION 'managed writer cannot issue before managed numbering' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.patient_number IS NOT NULL THEN
    RAISE EXCEPTION 'explicit patient number refused in managed mode' USING ERRCODE = '55000';
  END IF;
  ordinal := nextval('public.patient_number_seq'::regclass)::text;
  NEW.patient_number := policy.prefix || '-' || lpad(ordinal, greatest(5, length(ordinal)), '0');
  RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION numbering_review.assign_patient_number() FROM PUBLIC;
CREATE TRIGGER numbering_review_boundary
  BEFORE INSERT OR UPDATE OF patient_number ON public.patients
  FOR EACH ROW EXECUTE FUNCTION numbering_review.assign_patient_number();
ALTER TABLE public.patients ENABLE ALWAYS TRIGGER numbering_review_boundary;

-- Inspect the effective role graph, not only direct grants. This private guard
-- is shared by activation and review-only recovery, under the same table lock.
CREATE FUNCTION numbering_review.assert_runtime_fenced() RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Account-level grants or other reachable roles can outlive REVOKE on the group.
  -- Check all explicitly enrolled runtime descendants and roles they can assume.
  IF EXISTS (
    WITH RECURSIVE runtime_members(id) AS (
      SELECT 'aqlan_numbering_runtime'::regrole::oid
      UNION
      SELECT m.member FROM pg_auth_members m JOIN runtime_members a ON a.id = m.roleid
    ), reachable(id) AS (
      SELECT id FROM runtime_members
      UNION
      SELECT m.roleid FROM pg_auth_members m JOIN reachable a ON a.id = m.member
    )
    SELECT 1 FROM reachable a JOIN pg_roles r ON r.oid = a.id
    WHERE r.rolsuper OR r.rolcreaterole OR r.rolreplication
       OR r.oid IN ('aqlan_numbering_data_owner'::regrole::oid, 'aqlan_numbering_operator'::regrole::oid)
       OR has_sequence_privilege(r.oid, 'public.patient_number_seq'::regclass, 'USAGE,UPDATE')
       OR has_parameter_privilege(r.oid, 'session_replication_role', 'SET')
  ) THEN
    RAISE EXCEPTION 'runtime can bypass numbering boundary' USING ERRCODE = '55000';
  END IF;
END; $$;
REVOKE ALL ON FUNCTION numbering_review.assert_runtime_fenced() FROM PUBLIC;

-- SECURITY DEFINER reduces the pilot's privileged operations to this explicit surface.
-- The operator role is not clinic-owner proof. No product settings/API references this function.
CREATE FUNCTION numbering_review.set_managed_policy(expected bigint, new_prefix text, minimum_next bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  saved numbering_review.policy%ROWTYPE;
  seq_value bigint;
  called boolean;
  high numeric;
  requested numeric;
  max_sequence bigint;
BEGIN
  IF new_prefix IS NULL OR new_prefix COLLATE "C" !~ '^[A-Z]{1,6}$'
     OR minimum_next IS NULL OR minimum_next < 7000 OR expected IS NULL THEN
    RAISE EXCEPTION 'invalid managed numbering policy' USING ERRCODE = '22023';
  END IF;
  -- Old INSERT statements and the legacy startup's table lock hold incompatible locks.
  -- Keep this ordering: lock the target table before locking/reading the policy.
  LOCK TABLE public.patients IN ACCESS EXCLUSIVE MODE;
  SELECT p.* INTO STRICT saved FROM numbering_review.policy p WHERE singleton FOR UPDATE;
  IF expected <> saved.revision OR saved.phase = 'RECOVERY_HOLD'
     OR saved.database_binding IS DISTINCT FROM numbering_review.local_database_binding() THEN
    RAISE EXCEPTION 'stale numbering policy or recovery hold' USING ERRCODE = '55000';
  END IF;
  REVOKE ALL ON SEQUENCE public.patient_number_seq FROM PUBLIC, aqlan_numbering_runtime, aqlan_numbering_operator;

  PERFORM numbering_review.assert_runtime_fenced();

  SELECT seqmax INTO STRICT max_sequence FROM pg_sequence
     WHERE seqrelid = 'public.patient_number_seq'::regclass AND seqincrement = 1
       AND seqcache = 1 AND NOT seqcycle;
  -- Take the sequence's DDL lock before inspecting last_value. ALTER without RESTART
  -- preserves its next pending value and serializes against already-running sequence access.
  ALTER SEQUENCE public.patient_number_seq CACHE 1;
  SELECT last_value, is_called INTO STRICT seq_value, called FROM public.patient_number_seq;
  SELECT coalesce(max(split_part(patient_number, '-', 2)::numeric), 0) INTO high
    FROM public.patients WHERE upper(patient_number COLLATE "C") ~ ('^' || new_prefix || '-[0-9]+$');
  requested := greatest(minimum_next::numeric, seq_value::numeric + CASE WHEN called THEN 1 ELSE 0 END, high + 1);
  IF requested >= max_sequence THEN
    RAISE EXCEPTION 'numbering ceiling reached' USING ERRCODE = '22003';
  END IF;
  -- Unlike setval, ALTER RESTART is transactional; rejected changes cannot move the counter.
  IF requested > seq_value::numeric + (CASE WHEN called THEN 1 ELSE 0 END) THEN
    EXECUTE format('ALTER SEQUENCE public.patient_number_seq RESTART WITH %s', requested::bigint);
  END IF;
  UPDATE numbering_review.policy SET prefix = new_prefix, phase = 'MANAGED', revision = revision + 1
    WHERE singleton RETURNING revision INTO expected;
  RETURN expected;
END; $$;
REVOKE ALL ON FUNCTION numbering_review.set_managed_policy(bigint,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION numbering_review.set_managed_policy(bigint,text,bigint) TO aqlan_numbering_operator;

CREATE FUNCTION numbering_review.hold_issuance(expected bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE next_revision bigint;
BEGIN
  LOCK TABLE public.patients IN ACCESS EXCLUSIVE MODE;
  UPDATE numbering_review.policy SET phase = 'RECOVERY_HOLD', revision = revision + 1
    WHERE singleton AND phase = 'MANAGED' AND revision = expected
      AND database_binding = numbering_review.local_database_binding() RETURNING revision INTO next_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot enter recovery hold at this revision' USING ERRCODE = '55000';
  END IF;
  RETURN next_revision;
END; $$;
REVOKE ALL ON FUNCTION numbering_review.hold_issuance(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION numbering_review.hold_issuance(bigint) TO aqlan_numbering_operator;

CREATE FUNCTION numbering_review.inspect_checkpoint()
RETURNS TABLE(phase text, prefix text, revision bigint, last_value bigint, is_called boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN p.database_binding = numbering_review.local_database_binding()
         THEN p.phase ELSE 'RECOVERY_HOLD' END, p.prefix, p.revision, s.last_value, s.is_called
  FROM numbering_review.policy p CROSS JOIN public.patient_number_seq s WHERE p.singleton
$$;
REVOKE ALL ON FUNCTION numbering_review.inspect_checkpoint() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION numbering_review.inspect_checkpoint() TO aqlan_numbering_operator;
COMMIT;

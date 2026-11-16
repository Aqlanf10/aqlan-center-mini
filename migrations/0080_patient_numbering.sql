-- 0080: forward-only patient file allocation and immutable historical aliases. No existing number is changed.
CREATE TABLE patient_numbering_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  minimum_next bigint NOT NULL DEFAULT 7000 CHECK (minimum_next BETWEEN 7000 AND 9223372036854775807),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0)
);
-- No seed row: virtual default 7000/version 1 until the first explicit audited change.
ALTER TABLE patients ADD COLUMN patient_number_version bigint NOT NULL DEFAULT 1 CHECK (patient_number_version > 0);
-- No FK: retired identifiers must survive patient deletion/merge. No data backfill.
CREATE TABLE retired_patient_numbers (
  patient_number text PRIMARY KEY,
  patient_id bigint NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION aqlan_patient_number_key(n text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN upper(trim(n)) ~ '^P-[0-9]+$'
    THEN 'P-' || coalesce(nullif(ltrim(substring(upper(trim(n)) FROM 3),'0'),''),'0')
    ELSE upper(trim(n)) END
$$;
CREATE FUNCTION aqlan_patient_number_numeric(n text) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN alias_key ~ '^P-[0-9]{1,19}$' THEN substring(alias_key FROM 3)::numeric
    WHEN alias_key ~ '^P-[0-9]+$' THEN 9223372036854775808::numeric ELSE 0 END
  FROM (SELECT public.aqlan_patient_number_key(n) AS alias_key) normalized
$$;
-- Defense only: REQUIRED read-only readiness check runs before deployment/migrations.
-- Refuse ambiguity transactionally without rewriting, merging or renumbering records.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM patients GROUP BY aqlan_patient_number_key(patient_number) HAVING count(*)>1) THEN
    RAISE EXCEPTION 'patient numbering readiness refused: historical aliases need explicit reviewed correction';
  END IF;
END $$;
CREATE FUNCTION aqlan_patient_number_next() RETURNS numeric LANGUAGE sql VOLATILE AS $$
  SELECT greatest(
    coalesce((SELECT minimum_next::numeric FROM patient_numbering_policy WHERE singleton),7000),
    (SELECT last_value::numeric + CASE WHEN is_called THEN 1 ELSE 0 END FROM patient_number_seq),
    coalesce((SELECT max(aqlan_patient_number_numeric(patient_number))+1 FROM patients),1),
    coalesce((SELECT max(aqlan_patient_number_numeric(patient_number))+1 FROM retired_patient_numbers),1)
  )
$$;
CREATE FUNCTION aqlan_allocate_patient_number() RETURNS text LANGUAGE plpgsql AS $$
DECLARE next_number numeric; allocated bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'patient numbering requires READ COMMITTED' USING ERRCODE='25000';
  END IF;
  -- Same order as import and administrative writers. Every allocation is serialized;
  -- nextval/setval gaps after rollback are deliberate, never identifier reuse.
  PERFORM pg_advisory_xact_lock_shared(hashtext('patient_import'));
  PERFORM pg_advisory_xact_lock(hashtext('patient_numbering'));
  next_number := aqlan_patient_number_next();
  IF next_number > 9223372036854775807 THEN RAISE EXCEPTION 'patient number sequence exhausted' USING ERRCODE='2200H'; END IF;
  IF next_number > (SELECT last_value FROM patient_number_seq) THEN
    PERFORM setval('patient_number_seq',next_number::bigint,false);
  END IF;
  allocated := nextval('patient_number_seq');
  RETURN 'P-' || lpad(allocated::text,greatest(5,length(allocated::text)),'0');
END $$;
CREATE FUNCTION aqlan_patient_number_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.patient_number IS NOT DISTINCT FROM OLD.patient_number THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'patient numbering requires READ COMMITTED' USING ERRCODE='25000';
  END IF;
  -- Direct legacy writers fail fast instead of reversing patient-row/advisory order.
  IF NOT pg_try_advisory_xact_lock(hashtext('patient_numbering')) THEN
    RAISE EXCEPTION 'patient numbering busy; refresh and retry' USING ERRCODE='55P03';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF EXISTS(SELECT 1 FROM retired_patient_numbers r WHERE aqlan_patient_number_key(r.patient_number)=aqlan_patient_number_key(NEW.patient_number))
      OR EXISTS(SELECT 1 FROM patients p WHERE p.id<>NEW.id AND aqlan_patient_number_key(p.patient_number)=aqlan_patient_number_key(NEW.patient_number)) THEN
      RAISE EXCEPTION 'patient number is already used or retired' USING ERRCODE='23505';
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    INSERT INTO retired_patient_numbers(patient_number,patient_id) VALUES(OLD.patient_number,OLD.id) ON CONFLICT DO NOTHING;
    IF TG_OP='UPDATE' THEN NEW.patient_number_version := OLD.patient_number_version+1; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_number_identity_guard BEFORE INSERT OR UPDATE OF patient_number OR DELETE ON patients
FOR EACH ROW EXECUTE FUNCTION aqlan_patient_number_guard();

-- TRUNCATE does not invoke row retirement triggers. Only an empty identity table
-- may participate in the explicitly authorized patient-free reset/restore path.
CREATE FUNCTION aqlan_patient_number_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'patient numbering requires READ COMMITTED' USING ERRCODE='25000';
  END IF;
  IF EXISTS(SELECT 1 FROM patients) THEN
    RAISE EXCEPTION 'current patient identifiers cannot be truncated';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER patient_number_no_truncate BEFORE TRUNCATE ON patients
FOR EACH STATEMENT EXECUTE FUNCTION aqlan_patient_number_no_truncate();

-- Indexed projections: no historical values are rewritten or canonicalized.
CREATE INDEX patient_number_numeric_idx ON patients(aqlan_patient_number_numeric(patient_number));
CREATE UNIQUE INDEX patient_number_alias_key_idx ON patients(aqlan_patient_number_key(patient_number));
CREATE INDEX retired_patient_number_numeric_idx ON retired_patient_numbers(aqlan_patient_number_numeric(patient_number));
CREATE UNIQUE INDEX retired_patient_number_alias_key_idx ON retired_patient_numbers(aqlan_patient_number_key(patient_number));
-- Restore current identities first. A spelling-only change may reserve its own
-- normalized alias, but a historical alias must never claim another current patient.
CREATE FUNCTION aqlan_retired_patient_number_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'patient numbering requires READ COMMITTED' USING ERRCODE='25000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('patient_numbering')) THEN
    RAISE EXCEPTION 'patient numbering busy; refresh and retry' USING ERRCODE='55P03';
  END IF;
  IF EXISTS(SELECT 1 FROM patients p WHERE p.id <> NEW.patient_id
      AND aqlan_patient_number_key(p.patient_number)=aqlan_patient_number_key(NEW.patient_number)) THEN
    RAISE EXCEPTION 'retired patient number belongs to another current patient' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER retired_patient_number_insert_guard BEFORE INSERT ON retired_patient_numbers
FOR EACH ROW EXECUTE FUNCTION aqlan_retired_patient_number_insert_guard();
CREATE FUNCTION aqlan_retired_patient_number_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM retired_patient_numbers) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'retired patient identifiers are immutable';
END $$;
CREATE TRIGGER retired_patient_number_immutable BEFORE UPDATE OR DELETE ON retired_patient_numbers
FOR EACH ROW EXECUTE FUNCTION aqlan_retired_patient_number_immutable();
CREATE TRIGGER retired_patient_number_no_truncate BEFORE TRUNCATE ON retired_patient_numbers
FOR EACH STATEMENT EXECUTE FUNCTION aqlan_retired_patient_number_immutable();
CREATE FUNCTION aqlan_patient_number_policy_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'patient numbering policy cannot be erased'; END IF;
  IF TG_OP='UPDATE' AND (NEW.minimum_next <= OLD.minimum_next OR NEW.version <> OLD.version+1) THEN
    RAISE EXCEPTION 'patient numbering policy must advance monotonically';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patient_number_policy_monotonic BEFORE UPDATE OR DELETE ON patient_numbering_policy
FOR EACH ROW EXECUTE FUNCTION aqlan_patient_number_policy_monotonic();
CREATE TRIGGER patient_number_policy_no_truncate BEFORE TRUNCATE ON patient_numbering_policy
FOR EACH STATEMENT EXECUTE FUNCTION aqlan_patient_number_policy_monotonic();

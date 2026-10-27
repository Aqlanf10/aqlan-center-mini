-- UNNUMBERED PROPOSAL. Do not auto-apply from runtime schema initialization.
CREATE TABLE ortho_followup_coverage_revisions (
  id BIGSERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL CHECK (patient_id > 0), -- recorded owner; merge invalidates proof, never rewrites history
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id),
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id),
  plan_id INTEGER NOT NULL REFERENCES treatment_plans(id),
  plan_item_id INTEGER NOT NULL REFERENCES plan_items(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  version INTEGER NOT NULL CHECK (version > 0),
  supersedes_revision_id BIGINT REFERENCES ortho_followup_coverage_revisions(id),
  scope TEXT NOT NULL CHECK (scope = 'routine_adjustments'),
  decision TEXT NOT NULL CHECK (decision IN ('included', 'excluded')),
  source_fingerprint TEXT NOT NULL CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  source_snapshot JSONB NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 600),
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  command_id UUID NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  UNIQUE (ortho_case_id, version),
  CHECK ((version = 1) = (supersedes_revision_id IS NULL))
);
CREATE INDEX ortho_followup_coverage_head ON ortho_followup_coverage_revisions(ortho_case_id, version DESC);
CREATE FUNCTION guard_ortho_followup_coverage_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' AND current_setting('transaction_isolation') = 'read committed'
      AND NOT EXISTS (SELECT 1 FROM ortho_followup_coverage_revisions) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Orthodontic followup coverage revisions are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER ortho_followup_coverage_no_rewrite BEFORE UPDATE OR DELETE ON ortho_followup_coverage_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_ortho_followup_coverage_append_only();
CREATE TRIGGER ortho_followup_coverage_no_truncate BEFORE TRUNCATE ON ortho_followup_coverage_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ortho_followup_coverage_append_only();
ALTER TABLE ortho_adjustments ADD COLUMN followup_coverage_revision_id BIGINT REFERENCES ortho_followup_coverage_revisions(id);
-- The signed parent carries exact immutable child identities. This is replay
-- evidence, not a restore bypass: an existing signed visit cannot acquire it.
ALTER TABLE visits ADD COLUMN ortho_followup_coverage_proof JSONB;
CREATE FUNCTION guard_ortho_followup_visit_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry JSONB; revision RECORD; seen BIGINT[] := '{}';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.ortho_followup_coverage_proof IS NOT NULL THEN
      RAISE EXCEPTION 'Signed coverage manifest cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.signed_at IS NOT NULL AND
      (NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.signed_by IS DISTINCT FROM OLD.signed_by
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.ortho_followup_coverage_proof IS DISTINCT FROM OLD.ortho_followup_coverage_proof) THEN
    RAISE EXCEPTION 'Signed coverage manifest or signature cannot be rewritten' USING ERRCODE='23514';
  END IF;
  IF NEW.ortho_followup_coverage_proof IS NULL THEN RETURN NEW; END IF;
  IF NEW.signed_at IS NULL OR jsonb_typeof(NEW.ortho_followup_coverage_proof) <> 'array'
      OR jsonb_array_length(NEW.ortho_followup_coverage_proof) = 0 THEN
    RAISE EXCEPTION 'Coverage manifest requires a signed visit and a nonempty array' USING ERRCODE='23514';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.ortho_followup_coverage_proof) LOOP
    IF jsonb_typeof(entry) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(entry)) <> 4
      OR jsonb_typeof(entry->'adjustmentId') IS DISTINCT FROM 'number'
      OR jsonb_typeof(entry->'caseId') IS DISTINCT FROM 'number'
      OR jsonb_typeof(entry->'patientId') IS DISTINCT FROM 'number'
      OR jsonb_typeof(entry->'revisionId') IS DISTINCT FROM 'string'
      OR COALESCE(entry->>'adjustmentId','') !~ '^[1-9][0-9]{0,9}$'
      OR COALESCE(entry->>'caseId','') !~ '^[1-9][0-9]{0,9}$'
      OR COALESCE(entry->>'patientId','') !~ '^[1-9][0-9]{0,9}$'
      OR COALESCE(entry->>'revisionId','') !~ '^[1-9][0-9]{0,18}$' THEN
      RAISE EXCEPTION 'Malformed coverage manifest identity' USING ERRCODE='23514';
    END IF;
    IF (entry->>'adjustmentId')::BIGINT = ANY(seen) THEN
      RAISE EXCEPTION 'Duplicate coverage manifest adjustment' USING ERRCODE='23514';
    END IF;
    seen := array_append(seen,(entry->>'adjustmentId')::BIGINT);
    SELECT * INTO revision FROM ortho_followup_coverage_revisions WHERE id=(entry->>'revisionId')::BIGINT;
    IF revision.id IS NULL OR revision.ortho_case_id <> (entry->>'caseId')::BIGINT
      OR revision.patient_id <> (entry->>'patientId')::BIGINT OR revision.decision <> 'included' THEN
      RAISE EXCEPTION 'Coverage manifest revision identity mismatch' USING ERRCODE='23514';
    END IF;
    -- An ordinary signature needs existing exact work. A signed INSERT is the
    -- historical parent; its children are checked at transaction end below.
    IF TG_OP='UPDATE' AND OLD.signed_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM ortho_adjustments a WHERE a.id=(entry->>'adjustmentId')::BIGINT
        AND a.visit_id=NEW.id AND a.case_id=revision.ortho_case_id
        AND a.followup_coverage_revision_id=revision.id AND a.billing_class='INCLUDED'
        AND revision.patient_id=NEW.patient_id) THEN
      RAISE EXCEPTION 'Signature coverage manifest lacks exact current work' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ortho_followup_visit_manifest BEFORE INSERT OR UPDATE OR DELETE ON visits
  FOR EACH ROW EXECUTE FUNCTION guard_ortho_followup_visit_manifest();

CREATE FUNCTION guard_ortho_followup_adjustment_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof RECORD; parent RECORD; tuple JSONB;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.followup_coverage_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'Signed coverage proof cannot be deleted' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.followup_coverage_revision_id IS NOT NULL AND
      (NEW.followup_coverage_revision_id IS DISTINCT FROM OLD.followup_coverage_revision_id
       OR NEW.id IS DISTINCT FROM OLD.id OR NEW.case_id IS DISTINCT FROM OLD.case_id
       OR NEW.visit_id IS DISTINCT FROM OLD.visit_id) THEN
    RAISE EXCEPTION 'Signed coverage proof cannot be rewritten' USING ERRCODE='23514';
  END IF;
  IF NEW.followup_coverage_revision_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO proof FROM ortho_followup_coverage_revisions WHERE id=NEW.followup_coverage_revision_id;
  -- Serialize with signature; refuse an inverted direct writer rather than
  -- waiting behind a signer that already owns this adjustment.
  SELECT * INTO parent FROM visits WHERE id=NEW.visit_id FOR SHARE NOWAIT;
  IF TG_OP='UPDATE' AND OLD.followup_coverage_revision_id IS NOT NULL
      AND parent.signed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Signed coverage adjustment cannot be rewritten' USING ERRCODE='23514';
  END IF;
  IF proof.id IS NULL OR parent.id IS NULL OR proof.ortho_case_id IS DISTINCT FROM NEW.case_id
      OR proof.decision <> 'included' THEN
    RAISE EXCEPTION 'Coverage proof does not belong to this adjustment' USING ERRCODE='23514';
  END IF;
  tuple := jsonb_build_object('adjustmentId',NEW.id,'caseId',NEW.case_id,
    'revisionId',proof.id::TEXT,'patientId',proof.patient_id);
  IF parent.signed_at IS NOT NULL THEN
    IF NEW.billing_class IS DISTINCT FROM 'INCLUDED' OR parent.ortho_followup_coverage_proof IS NULL
        OR NOT parent.ortho_followup_coverage_proof @> jsonb_build_array(tuple) THEN
      RAISE EXCEPTION 'A prior signed adjustment cannot acquire a new coverage proof' USING ERRCODE='23514';
    END IF;
  ELSIF proof.patient_id IS DISTINCT FROM parent.patient_id THEN
    RAISE EXCEPTION 'Coverage proof current owner mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ortho_followup_adjustment_proof BEFORE INSERT OR UPDATE OR DELETE ON ortho_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_ortho_followup_adjustment_proof();

-- Validate complete signed parent/child agreement after restore has inserted
-- both sides. No session flag, actor name or trigger bypass grants an exception.
CREATE FUNCTION check_ortho_followup_manifest_children() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target INTEGER; parent RECORD; actual JSONB;
BEGIN
  IF TG_TABLE_NAME='visits' THEN target := NEW.id; ELSE target := NEW.visit_id; END IF;
  SELECT * INTO parent FROM visits WHERE id=target;
  IF parent.id IS NULL OR parent.signed_at IS NULL THEN RETURN NULL; END IF;
  SELECT jsonb_agg(jsonb_build_object('adjustmentId',a.id,'caseId',a.case_id,
      'revisionId',r.id::TEXT,'patientId',r.patient_id) ORDER BY a.id) INTO actual
    FROM ortho_adjustments a JOIN ortho_followup_coverage_revisions r ON r.id=a.followup_coverage_revision_id
    WHERE a.visit_id=target AND a.billing_class='INCLUDED';
  IF (actual IS NULL) <> (parent.ortho_followup_coverage_proof IS NULL)
      OR (actual IS NOT NULL AND (NOT actual @> parent.ortho_followup_coverage_proof
        OR NOT parent.ortho_followup_coverage_proof @> actual))
      OR EXISTS (SELECT 1 FROM ortho_adjustments a WHERE a.visit_id=target
        AND a.followup_coverage_revision_id IS NOT NULL AND a.billing_class IS DISTINCT FROM 'INCLUDED') THEN
    RAISE EXCEPTION 'Signed coverage manifest children mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ortho_followup_manifest_children AFTER INSERT OR UPDATE ON visits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_followup_manifest_children();
CREATE CONSTRAINT TRIGGER ortho_followup_proof_parent AFTER INSERT OR UPDATE ON ortho_adjustments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_followup_manifest_children();

CREATE FUNCTION guard_ortho_followup_coverage_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous RECORD;
BEGIN
  -- Lock the stream, but do not require today's source owner to equal recorded
  -- ownership. Historical snapshots survive supported patient merges unchanged.
  PERFORM id FROM ortho_cases WHERE id=NEW.ortho_case_id FOR UPDATE;
  IF NOT FOUND OR NEW.source_snapshot->>'format' IS DISTINCT FROM '1'
    OR NEW.source_snapshot#>>'{case,0}' IS DISTINCT FROM NEW.ortho_case_id::TEXT
    OR NEW.source_snapshot#>>'{case,1}' IS DISTINCT FROM NEW.patient_id::TEXT
    OR NEW.source_snapshot#>>'{clinical,0}' IS DISTINCT FROM NEW.clinical_case_id::TEXT
    OR NEW.source_snapshot#>>'{clinical,1}' IS DISTINCT FROM NEW.patient_id::TEXT
    OR NEW.source_snapshot#>>'{clinical,2}' IS DISTINCT FROM NEW.ortho_case_id::TEXT
    OR NEW.source_snapshot#>>'{plan,0}' IS DISTINCT FROM NEW.plan_id::TEXT
    OR NEW.source_snapshot#>>'{plan,1}' IS DISTINCT FROM NEW.patient_id::TEXT
    OR NEW.source_snapshot#>>'{item,0}' IS DISTINCT FROM NEW.plan_item_id::TEXT
    OR NEW.source_snapshot#>>'{item,1}' IS DISTINCT FROM NEW.plan_id::TEXT
    OR NEW.source_snapshot#>>'{item,2}' IS DISTINCT FROM NEW.clinical_case_id::TEXT
    OR NEW.source_snapshot#>>'{invoice,0}' IS DISTINCT FROM NEW.invoice_id::TEXT
    OR NEW.source_snapshot#>>'{invoice,1}' IS DISTINCT FROM NEW.patient_id::TEXT THEN
    RAISE EXCEPTION 'Coverage historical source snapshot identity mismatch' USING ERRCODE='23514';
  END IF;
  SELECT id,version INTO previous FROM ortho_followup_coverage_revisions WHERE ortho_case_id=NEW.ortho_case_id ORDER BY version DESC LIMIT 1;
  IF NEW.version <> COALESCE(previous.version,0)+1 OR NEW.supersedes_revision_id IS DISTINCT FROM previous.id THEN
    RAISE EXCEPTION 'Coverage revision chain changed; reload' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ortho_followup_coverage_chain BEFORE INSERT ON ortho_followup_coverage_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_ortho_followup_coverage_chain();

CREATE FUNCTION guard_ortho_followup_proof_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed'
      OR EXISTS (SELECT 1 FROM ortho_adjustments WHERE followup_coverage_revision_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM visits WHERE ortho_followup_coverage_proof IS NOT NULL) THEN
    RAISE EXCEPTION 'Signed coverage proof cannot be truncated' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER ortho_followup_adjustment_no_truncate BEFORE TRUNCATE ON ortho_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ortho_followup_proof_truncate();
CREATE TRIGGER ortho_followup_visit_no_truncate BEFORE TRUNCATE ON visits
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ortho_followup_proof_truncate();

-- Exact command terminal refusals survive source changes and patient merges.
CREATE TABLE ortho_followup_coverage_rejections (
  command_id UUID PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  patient_id INTEGER NOT NULL CHECK (patient_id>0),
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id),
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  actor TEXT NOT NULL CHECK (length(btrim(actor))>0),
  command JSONB NOT NULL CHECK (jsonb_typeof(command)='object'),
  code TEXT NOT NULL CHECK (code IN ('source_changed','stale_coverage','case_closed')),
  message TEXT NOT NULL CHECK (length(btrim(message))>0),
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_ortho_followup_command_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF current_setting('transaction_isolation')='read committed'
        AND NOT EXISTS(SELECT 1 FROM ortho_followup_coverage_rejections) THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'Coverage refusal history cannot be truncated' USING ERRCODE='23514';
  END IF;
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Coverage refusal history is append-only' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='ortho_followup_coverage_rejections' THEN
    IF NOT (NEW.command ?& ARRAY['schemaVersion','commandId','expectedRevisionId','source','expectedSourceFingerprint','scope','decision','reason'])
      OR jsonb_typeof(NEW.command->'schemaVersion') IS DISTINCT FROM 'number'
      OR NEW.command->>'commandId' IS DISTINCT FROM NEW.command_id::TEXT
      OR NEW.command->>'schemaVersion' IS DISTINCT FROM '1'
      OR NEW.command#>>'{source,patientId}' IS DISTINCT FROM NEW.patient_id::TEXT
      OR NEW.command#>>'{source,orthoCaseId}' IS DISTINCT FROM NEW.ortho_case_id::TEXT
      OR NEW.command->>'scope' IS DISTINCT FROM 'routine_adjustments'
      OR COALESCE(NEW.command->>'expectedSourceFingerprint','') !~ '^[0-9a-f]{64}$'
      OR COALESCE(NEW.command->>'decision','') NOT IN ('included','excluded')
      OR jsonb_typeof(NEW.command->'reason') IS DISTINCT FROM 'string'
      OR length(btrim(NEW.command->>'reason')) NOT BETWEEN 3 AND 600
      OR jsonb_typeof(NEW.command->'source') IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.command))<>8
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.command->'source'))<>6
      OR NOT (NEW.command->'source' ?& ARRAY['patientId','orthoCaseId','clinicalCaseId','planId','planItemId','invoiceId'])
      OR EXISTS (SELECT 1 FROM jsonb_each(NEW.command->'source') e
        WHERE jsonb_typeof(e.value)<>'number' OR e.value::TEXT !~ '^[1-9][0-9]*$')
      OR NOT (NEW.command->'expectedRevisionId'='null'::jsonb
        OR (jsonb_typeof(NEW.command->'expectedRevisionId')='string'
          AND NEW.command->>'expectedRevisionId' ~ '^[1-9][0-9]{0,18}$')) THEN
      RAISE EXCEPTION 'Coverage refusal command identity mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ortho-followup-command:' || NEW.command_id::TEXT,0));
  IF (TG_TABLE_NAME='ortho_followup_coverage_revisions' AND EXISTS(
        SELECT 1 FROM ortho_followup_coverage_rejections WHERE command_id=NEW.command_id))
      OR (TG_TABLE_NAME='ortho_followup_coverage_rejections' AND EXISTS(
        SELECT 1 FROM ortho_followup_coverage_revisions WHERE command_id=NEW.command_id)) THEN
    RAISE EXCEPTION 'Coverage command already has a terminal outcome' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ortho_followup_coverage_00_command BEFORE INSERT ON ortho_followup_coverage_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_ortho_followup_command_terminal();
CREATE TRIGGER ortho_followup_rejection_immutable BEFORE INSERT OR UPDATE OR DELETE ON ortho_followup_coverage_rejections
  FOR EACH ROW EXECUTE FUNCTION guard_ortho_followup_command_terminal();
CREATE TRIGGER ortho_followup_rejection_no_truncate BEFORE TRUNCATE ON ortho_followup_coverage_rejections
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ortho_followup_command_terminal();

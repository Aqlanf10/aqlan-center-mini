-- Unpublished0054 source proposal. No backfill, grant, clinical event, invoice or debt.
-- Existing explicit treatment writers retain their values/default compatibility.
ALTER TABLE ortho_cases ALTER COLUMN appliance DROP NOT NULL;
ALTER TABLE ortho_cases ALTER COLUMN arches DROP NOT NULL;
ALTER TABLE ortho_cases ALTER COLUMN slot DROP NOT NULL;
ALTER TABLE ortho_cases ALTER COLUMN phase DROP NOT NULL;
ALTER TABLE ortho_cases ALTER COLUMN start_date DROP NOT NULL;
ALTER TABLE ortho_cases ALTER COLUMN planned_months DROP NOT NULL;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS assessment_opened_at TIMESTAMPTZ;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS assessment_cancelled_at TIMESTAMPTZ;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS assessment_cancelled_reason TEXT;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS assessment_intake_kind TEXT;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS lifecycle_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS treatment_start_evidence JSONB;
-- Preserve the prior index; this stricter additive index includes the waiting episode.
CREATE UNIQUE INDEX IF NOT EXISTS ortho_cases_one_open_including_assessment
  ON ortho_cases(patient_id) WHERE status IN ('assessment','active','retention');
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='ortho_cases'::regclass AND conname='ortho_assessment_lifecycle_shape') THEN
    ALTER TABLE ortho_cases ADD CONSTRAINT ortho_assessment_lifecycle_shape CHECK (
      lifecycle_version>=0
      AND (assessment_intake_kind IS NULL OR assessment_intake_kind IN ('new','transferred','unknown'))
      AND (treatment_start_evidence IS NULL OR jsonb_typeof(treatment_start_evidence)='object')
      AND (status NOT IN ('assessment','assessment_cancelled') OR (
        appliance IS NULL AND arches IS NULL AND slot IS NULL AND bracket_system IS NULL AND phase IS NULL
        AND start_date IS NULL AND planned_months IS NULL AND upper_wire IS NULL AND lower_wire IS NULL
        AND retainer IS NULL AND retainer_on IS NULL AND plan_id IS NULL AND treatment_start_evidence IS NULL
        AND assessment_opened_at IS NOT NULL AND assessment_intake_kind IS NOT NULL AND lifecycle_version>0
      ))
      AND (status<>'assessment' OR (assessment_cancelled_at IS NULL AND assessment_cancelled_reason IS NULL AND closed_at IS NULL))
      AND (status<>'assessment_cancelled' OR (assessment_cancelled_at IS NOT NULL
        AND length(btrim(coalesce(assessment_cancelled_reason,''))) BETWEEN 1 AND 500
        AND closed_at IS NOT DISTINCT FROM assessment_cancelled_at))
    ) NOT VALID;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS ortho_case_lifecycle_events (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version>0),
  predecessor_id INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('assessment_opened','assessment_activated','assessment_cancelled')),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_by TEXT NOT NULL CHECK(length(btrim(recorded_by)) BETWEEN 1 AND 200),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  command_id TEXT NOT NULL CHECK(command_id ~ '^[A-Za-z0-9_-]{16,80}$'),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  content_version SMALLINT NOT NULL CHECK(content_version=1),
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  content JSONB NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=65536),
  CONSTRAINT ortho_lifecycle_content_identity CHECK ((content->'schemaVersion'='1'::jsonb AND jsonb_typeof(content->'command')='object'
    AND jsonb_typeof(content->'policy')='object' AND content->'command'->'schemaVersion'='1'::jsonb
    AND content->'command'->>'commandId'=command_id AND content->'command'->>'reason'=reason
    AND content->'command'->>'patientId'=recorded_patient_id::text
    AND CASE kind WHEN 'assessment_opened' THEN content->'command'->>'kind'='open_assessment'
      WHEN 'assessment_activated' THEN content->'command'->>'kind'='activate_assessment'
      WHEN 'assessment_cancelled' THEN content->'command'->>'kind'='cancel_assessment' END) IS TRUE),
  CONSTRAINT ortho_lifecycle_case_version UNIQUE(ortho_case_id,version),
  CONSTRAINT ortho_lifecycle_case_identity UNIQUE(ortho_case_id,id),
  -- Creation retry has no case ID yet. Actor+command is global, never a new case on retry.
  CONSTRAINT ortho_lifecycle_actor_command UNIQUE(actor_user_id,command_id),
  CONSTRAINT ortho_lifecycle_successor UNIQUE(predecessor_id),
  CONSTRAINT ortho_lifecycle_root CHECK((version=1)=(predecessor_id IS NULL)),
  CONSTRAINT ortho_lifecycle_open_root CHECK((kind='assessment_opened')=(version=1)),
  CONSTRAINT ortho_lifecycle_no_self CHECK(predecessor_id IS NULL OR predecessor_id<>id),
  CONSTRAINT ortho_lifecycle_same_case_predecessor FOREIGN KEY(ortho_case_id,predecessor_id)
    REFERENCES ortho_case_lifecycle_events(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS ortho_lifecycle_patient_case_idx ON ortho_case_lifecycle_events(patient_id,ortho_case_id,version DESC);
CREATE OR REPLACE FUNCTION reject_ortho_lifecycle_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'patient_id')=(to_jsonb(OLD)-'patient_id') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Ortho lifecycle evidence is append-only' USING ERRCODE='55000';
END;
$$;
CREATE OR REPLACE FUNCTION check_ortho_lifecycle_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e ortho_case_lifecycle_events%ROWTYPE; previous ortho_case_lifecycle_events%ROWTYPE;
  c ortho_cases%ROWTYPE; b clinical_cases%ROWTYPE; head ortho_case_lifecycle_events%ROWTYPE; root ortho_case_lifecycle_events%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='ortho_case_lifecycle_events' THEN
    SELECT * INTO e FROM ortho_case_lifecycle_events WHERE id=NEW.id;
    SELECT * INTO c FROM ortho_cases WHERE id=e.ortho_case_id;
    SELECT * INTO b FROM clinical_cases WHERE id=e.clinical_case_id;
    IF c.patient_id IS DISTINCT FROM e.patient_id OR b.patient_id IS DISTINCT FROM e.patient_id OR b.ortho_case_id IS DISTINCT FROM e.ortho_case_id THEN
      RAISE EXCEPTION 'Ortho lifecycle owner mismatch' USING ERRCODE='23514';
    END IF;
    IF e.predecessor_id IS NOT NULL THEN
      SELECT * INTO previous FROM ortho_case_lifecycle_events WHERE id=e.predecessor_id AND ortho_case_id=e.ortho_case_id;
      IF NOT FOUND OR previous.version+1<>e.version OR previous.clinical_case_id<>e.clinical_case_id
        OR previous.kind<>'assessment_opened' OR e.kind NOT IN ('assessment_activated','assessment_cancelled') THEN
        RAISE EXCEPTION 'Ortho lifecycle transition mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='clinical_cases' THEN
    SELECT * INTO b FROM clinical_cases WHERE id=NEW.id;
    IF EXISTS(SELECT 1 FROM ortho_case_lifecycle_events x WHERE x.clinical_case_id=b.id
      AND (x.ortho_case_id IS DISTINCT FROM b.ortho_case_id OR x.patient_id IS DISTINCT FROM b.patient_id)) THEN
      RAISE EXCEPTION 'Recorded lifecycle bridge ownership mismatch' USING ERRCODE='23514';
    END IF;
    IF b.ortho_case_id IS NULL THEN
      IF EXISTS(SELECT 1 FROM ortho_case_lifecycle_events WHERE clinical_case_id=NEW.id) THEN
        RAISE EXCEPTION 'Recorded lifecycle bridge cannot be detached' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END IF;
    SELECT * INTO c FROM ortho_cases WHERE id=b.ortho_case_id;
  ELSE
    SELECT * INTO c FROM ortho_cases WHERE id=NEW.id;
  END IF;
  IF c.lifecycle_version=0 THEN
    IF EXISTS(SELECT 1 FROM ortho_case_lifecycle_events WHERE ortho_case_id=c.id) OR c.status IN ('assessment','assessment_cancelled') THEN RAISE EXCEPTION 'Assessment lifecycle evidence missing' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO head FROM ortho_case_lifecycle_events WHERE ortho_case_id=c.id ORDER BY version DESC LIMIT 1;
  IF NOT FOUND OR head.version<>c.lifecycle_version OR c.assessment_opened_at IS NULL THEN
    RAISE EXCEPTION 'Ortho lifecycle head mismatch' USING ERRCODE='23514';
  END IF;
  SELECT * INTO b FROM clinical_cases WHERE id=head.clinical_case_id;
  IF head.patient_id IS DISTINCT FROM c.patient_id OR b.patient_id IS DISTINCT FROM c.patient_id
    OR b.ortho_case_id IS DISTINCT FROM c.id OR b.specialty IS DISTINCT FROM 'orthodontics' THEN
    RAISE EXCEPTION 'Lifecycle parent ownership mismatch' USING ERRCODE='23514';
  END IF;
  SELECT * INTO root FROM ortho_case_lifecycle_events WHERE ortho_case_id=c.id AND version=1;
  IF NOT FOUND OR root.recorded_at IS DISTINCT FROM c.assessment_opened_at
    OR root.content->'command'->>'intakeKind' IS DISTINCT FROM c.assessment_intake_kind THEN
    RAISE EXCEPTION 'Lifecycle opening evidence mismatch' USING ERRCODE='23514';
  END IF;
  IF head.kind='assessment_cancelled' AND root.content->'policy'->'bridgeAtOpening' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'Pre-existing clinical episode cancellation needs an explicit reviewed transition' USING ERRCODE='23514';
  END IF;
  IF head.kind='assessment_cancelled' AND (head.recorded_at IS DISTINCT FROM c.assessment_cancelled_at
    OR head.reason IS DISTINCT FROM c.assessment_cancelled_reason OR b.status IS DISTINCT FROM 'cancelled'
    OR b.completed_at IS DISTINCT FROM c.assessment_cancelled_at) THEN
    RAISE EXCEPTION 'Lifecycle cancellation evidence mismatch' USING ERRCODE='23514';
  END IF;
  IF (head.kind='assessment_opened' AND c.status<>'assessment')
    OR (head.kind='assessment_cancelled' AND c.status<>'assessment_cancelled')
    OR (head.kind='assessment_activated' AND c.status NOT IN ('active','retention','completed','discontinued')) THEN
    RAISE EXCEPTION 'Ortho lifecycle state mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_case_lifecycle_events'::regclass AND tgname='ortho_lifecycle_no_mutation') THEN
    CREATE TRIGGER ortho_lifecycle_no_mutation BEFORE UPDATE OR DELETE ON ortho_case_lifecycle_events FOR EACH ROW EXECUTE FUNCTION reject_ortho_lifecycle_mutation();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_case_lifecycle_events'::regclass AND tgname='ortho_lifecycle_final_state') THEN
    CREATE CONSTRAINT TRIGGER ortho_lifecycle_final_state AFTER INSERT OR UPDATE ON ortho_case_lifecycle_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_lifecycle_final_state();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='clinical_cases'::regclass AND tgname='ortho_bridge_lifecycle_final_state') THEN
    CREATE CONSTRAINT TRIGGER ortho_bridge_lifecycle_final_state AFTER INSERT OR UPDATE ON clinical_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_lifecycle_final_state();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_cases'::regclass AND tgname='ortho_case_lifecycle_final_state') THEN
    CREATE CONSTRAINT TRIGGER ortho_case_lifecycle_final_state AFTER INSERT OR UPDATE ON ortho_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_lifecycle_final_state();
  END IF;
END $$;

-- 0053's relation-scoped named constraints are the exact predecessor contract.
-- Decisions may be documented during assessment; physical retention remains
-- restricted to its existing treatment statuses in both SQL and the writer.
ALTER TABLE ortho_decision_revisions DROP CONSTRAINT ortho_journey_capture_status_check;
ALTER TABLE ortho_decision_revisions ADD CONSTRAINT ortho_journey_capture_status_check
  CHECK(case_status_at_capture IN ('assessment','assessment_cancelled','active','retention','completed','discontinued'));
ALTER TABLE ortho_decision_revisions DROP CONSTRAINT ortho_journey_context_status_check;
ALTER TABLE ortho_decision_revisions ADD CONSTRAINT ortho_journey_context_status_check
  CHECK((recording_context='retrospective')=(case_status_at_capture IN ('assessment_cancelled','completed','discontinued')));

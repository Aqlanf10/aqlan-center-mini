/** Selectively integrated assessment intake; no clinical decisions or finance engine migration. */
export const ORTHO_ASSESSMENT_INTAKE_SQL = `-- A diagnostic episode is not evidence that an appliance was fitted.
ALTER TABLE ortho_cases ALTER COLUMN appliance DROP NOT NULL;
ALTER TABLE ortho_cases ALTER COLUMN arches DROP NOT NULL;
ALTER TABLE ortho_cases ALTER COLUMN slot DROP NOT NULL;
ALTER TABLE ortho_cases ALTER COLUMN start_date DROP NOT NULL;
ALTER TABLE ortho_cases ALTER COLUMN planned_months DROP NOT NULL;
ALTER TABLE ortho_cases ADD CONSTRAINT ortho_assessment_state_check CHECK (
 (status IN ('assessment','discontinued') AND phase='assessment' AND appliance IS NULL AND arches IS NULL AND slot IS NULL
  AND start_date IS NULL AND planned_months IS NULL AND bracket_system IS NULL AND upper_wire IS NULL
  AND lower_wire IS NULL AND retainer IS NULL AND retainer_on IS NULL AND (status='discontinued' OR closed_at IS NULL))
 OR (status<>'assessment' AND phase<>'assessment' AND appliance IS NOT NULL AND arches IS NOT NULL
  AND (slot IS NOT NULL OR appliance IN ('aligners','removable','functional')) AND start_date IS NOT NULL AND planned_months IS NOT NULL)
);
CREATE UNIQUE INDEX ortho_cases_one_open_assessment_idx ON ortho_cases(patient_id) WHERE status IN ('assessment','active','retention');
CREATE TABLE ortho_case_intake_events (
 id SERIAL PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
 recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
 ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
 clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
 event_kind TEXT NOT NULL CHECK(event_kind IN ('opened','existing','treatment_started')),
 actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 command JSONB NOT NULL CHECK(jsonb_typeof(command)='object'),
 UNIQUE(patient_id,actor_user_id,command_id)
);
CREATE UNIQUE INDEX ortho_intake_single_transition_idx ON ortho_case_intake_events(ortho_case_id,event_kind) WHERE event_kind IN ('opened','treatment_started');
CREATE FUNCTION reject_ortho_intake_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' AND NOT EXISTS (SELECT 1 FROM ortho_case_intake_events) THEN RETURN NULL; END IF;
 -- Canonical duplicate-patient merge changes current ownership only; original
 -- patient provenance, command, actor, hash and fixed case IDs stay immutable.
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'patient_id')=(to_jsonb(OLD)-'patient_id') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Orthodontic intake events are append-only' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER ortho_case_intake_events_immutable BEFORE UPDATE OR DELETE ON ortho_case_intake_events
 FOR EACH ROW EXECUTE FUNCTION reject_ortho_intake_mutation();
CREATE TRIGGER ortho_case_intake_events_no_truncate BEFORE TRUNCATE ON ortho_case_intake_events
 FOR EACH STATEMENT EXECUTE FUNCTION reject_ortho_intake_mutation();
CREATE FUNCTION check_ortho_intake_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM ortho_case_intake_events e JOIN ortho_cases o ON o.id=e.ortho_case_id JOIN clinical_cases c ON c.id=e.clinical_case_id
 WHERE ((TG_TABLE_NAME='ortho_case_intake_events' AND e.id=NEW.id) OR (TG_TABLE_NAME='ortho_cases' AND e.ortho_case_id=NEW.id) OR (TG_TABLE_NAME='clinical_cases' AND e.clinical_case_id=NEW.id))
 AND (e.patient_id<>o.patient_id OR e.patient_id<>c.patient_id OR c.ortho_case_id IS DISTINCT FROM e.ortho_case_id)) THEN
 RAISE EXCEPTION 'Orthodontic intake ownership must match' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER ortho_intake_event_scope AFTER INSERT OR UPDATE ON ortho_case_intake_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_intake_scope();
CREATE CONSTRAINT TRIGGER ortho_intake_case_scope AFTER UPDATE ON ortho_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_intake_scope();
CREATE CONSTRAINT TRIGGER ortho_intake_bridge_scope AFTER UPDATE ON clinical_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_intake_scope();

`;

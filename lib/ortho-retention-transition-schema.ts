/** 0101 is additive; no existing case, date, device or financial fact is inferred. */
export const ORTHO_RETENTION_TRANSITION_SQL = `CREATE TABLE ortho_retention_transitions (
 id SERIAL PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
 recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
 ortho_case_id INTEGER NOT NULL UNIQUE REFERENCES ortho_cases(id) ON DELETE RESTRICT,
 clinical_case_id INTEGER NOT NULL UNIQUE REFERENCES clinical_cases(id) ON DELETE RESTRICT,
 actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_by TEXT NOT NULL CHECK(length(btrim(created_by)) BETWEEN 1 AND 200),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 from_phase TEXT NOT NULL CHECK(from_phase IN ('aligning','working','finishing','retention')),
 occurred_on DATE,
 date_provenance TEXT NOT NULL CHECK(date_provenance IN ('contemporaneous_record','retrospective_record','historical_source','unknown')),
 source_note TEXT NOT NULL CHECK(length(btrim(source_note)) BETWEEN 1 AND 1000),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 retention_plan TEXT NOT NULL CHECK(length(btrim(retention_plan)) BETWEEN 1 AND 4000),
 CHECK((date_provenance='unknown')=(occurred_on IS NULL))
);
CREATE INDEX ortho_retention_transitions_patient_idx ON ortho_retention_transitions(patient_id,ortho_case_id);
CREATE TRIGGER ortho_retention_transitions_immutable BEFORE UPDATE OR DELETE ON ortho_retention_transitions
 FOR EACH ROW EXECUTE FUNCTION reject_ortho_journey_mutation();
CREATE FUNCTION check_ortho_retention_transition_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM ortho_retention_transitions t
  JOIN ortho_cases o ON o.id=t.ortho_case_id JOIN clinical_cases c ON c.id=t.clinical_case_id
  WHERE ((TG_TABLE_NAME='ortho_retention_transitions' AND t.id=NEW.id)
   OR (TG_TABLE_NAME='ortho_cases' AND t.ortho_case_id=NEW.id)
   OR (TG_TABLE_NAME='clinical_cases' AND t.clinical_case_id=NEW.id))
   AND (t.patient_id<>o.patient_id OR t.patient_id<>c.patient_id OR c.ortho_case_id IS DISTINCT FROM t.ortho_case_id)) THEN
  RAISE EXCEPTION 'Retention transition ownership must match both cases' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER ortho_retention_transitions_scope AFTER INSERT OR UPDATE ON ortho_retention_transitions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_transition_scope();
CREATE CONSTRAINT TRIGGER ortho_retention_transition_case_scope AFTER UPDATE ON ortho_cases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_transition_scope();
CREATE CONSTRAINT TRIGGER ortho_retention_transition_bridge_scope AFTER UPDATE ON clinical_cases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_transition_scope();
`;

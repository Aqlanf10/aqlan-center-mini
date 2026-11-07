/** Exact additive runtime mirror of migration 0117. */
export const ORTHO_PROBLEM_SOURCES_SQL = `CREATE TABLE ortho_problem_source_reviews (
 id SERIAL PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
 recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
 ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
 clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
 problem_id INTEGER NOT NULL REFERENCES patient_problems(id) ON DELETE RESTRICT,
 actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 source_identity TEXT NOT NULL CHECK(length(source_identity) BETWEEN 1 AND 160),
 source_version TEXT NOT NULL CHECK(source_version ~ '^sha256:[a-f0-9]{64}$'),
 source_snapshot JSONB NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=262144),
 problem_label TEXT NOT NULL CHECK(length(btrim(problem_label)) BETWEEN 1 AND 2000),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 supersedes_review_id INTEGER REFERENCES ortho_problem_source_reviews(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 UNIQUE(patient_id,actor_user_id,command_id),
 UNIQUE(ortho_case_id,source_identity,source_version),
 UNIQUE(supersedes_review_id)
);
CREATE INDEX ortho_problem_source_case_idx ON ortho_problem_source_reviews(ortho_case_id,id DESC);
CREATE FUNCTION reject_ortho_problem_source_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_problem_source_reviews) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'Problem source reviews are append-only' USING ERRCODE='55000';
END; $$;
CREATE TRIGGER ortho_problem_source_no_truncate BEFORE TRUNCATE ON ortho_problem_source_reviews
 FOR EACH STATEMENT EXECUTE FUNCTION reject_ortho_problem_source_mutation();
CREATE TRIGGER ortho_problem_source_immutable BEFORE UPDATE OR DELETE ON ortho_problem_source_reviews
 FOR EACH ROW EXECUTE FUNCTION reject_ortho_problem_source_mutation();
CREATE FUNCTION check_ortho_problem_source_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ortho_problem_source_reviews' THEN
  PERFORM o.id FROM ortho_cases o JOIN ortho_problem_source_reviews r ON r.ortho_case_id=o.id WHERE r.id=NEW.id FOR SHARE OF o;
  PERFORM c.id FROM clinical_cases c JOIN ortho_problem_source_reviews r ON r.clinical_case_id=c.id WHERE r.id=NEW.id FOR SHARE OF c;
  PERFORM p.id FROM patient_problems p JOIN ortho_problem_source_reviews r ON r.problem_id=p.id WHERE r.id=NEW.id FOR SHARE OF p;
 END IF;
 IF EXISTS(SELECT 1 FROM ortho_problem_source_reviews r JOIN ortho_cases o ON o.id=r.ortho_case_id
 JOIN clinical_cases c ON c.id=r.clinical_case_id JOIN patient_problems p ON p.id=r.problem_id
 LEFT JOIN ortho_problem_source_reviews previous ON previous.id=r.supersedes_review_id
 WHERE ((TG_TABLE_NAME='ortho_problem_source_reviews' AND r.id=NEW.id) OR (TG_TABLE_NAME='ortho_cases' AND r.ortho_case_id=NEW.id)
 OR (TG_TABLE_NAME='clinical_cases' AND r.clinical_case_id=NEW.id) OR (TG_TABLE_NAME='patient_problems' AND r.problem_id=NEW.id))
 AND (r.patient_id<>o.patient_id OR r.patient_id<>c.patient_id OR r.patient_id<>p.patient_id
 OR c.specialty<>'orthodontics' OR p.specialty IS DISTINCT FROM 'orthodontics'
 OR c.ortho_case_id IS DISTINCT FROM r.ortho_case_id OR p.case_id IS DISTINCT FROM r.clinical_case_id
 OR (r.supersedes_review_id IS NOT NULL AND (previous.id IS NULL OR previous.clinical_case_id<>r.clinical_case_id OR previous.id>=r.id OR previous.ortho_case_id<>r.ortho_case_id
 OR previous.source_identity<>r.source_identity OR previous.patient_id<>r.patient_id)))) THEN
 RAISE EXCEPTION 'Orthodontic problem source ownership or lineage changed' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER ortho_problem_source_scope AFTER INSERT OR UPDATE ON ortho_problem_source_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_problem_source_scope();
CREATE CONSTRAINT TRIGGER ortho_problem_source_case_scope AFTER UPDATE ON ortho_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_problem_source_scope();
CREATE CONSTRAINT TRIGGER ortho_problem_source_bridge_scope AFTER UPDATE ON clinical_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_problem_source_scope();
CREATE CONSTRAINT TRIGGER ortho_problem_source_problem_scope AFTER UPDATE ON patient_problems DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_problem_source_scope();
`;

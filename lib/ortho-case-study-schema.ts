/** Registered additive saved-study migration. Study history is immutable; only
 * canonical patient ownership may move, while recorded identity/content remain. */
export const ORTHO_CASE_STUDY_SQL = `CREATE TABLE ortho_case_study_revisions (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK(schema_version=1),
  kind TEXT NOT NULL CHECK(kind IN ('draft','documented')),
  version INTEGER NOT NULL CHECK(version>0),
  predecessor_id INTEGER,
  documented_from_id INTEGER,
  base_documented_id INTEGER,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  content JSONB NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=2097152),
  CONSTRAINT ortho_study_case_version_unique UNIQUE(ortho_case_id,version),
  CONSTRAINT ortho_study_case_identity_unique UNIQUE(ortho_case_id,id),
  CONSTRAINT ortho_study_command_unique UNIQUE(ortho_case_id,actor_user_id,command_id),
  CONSTRAINT ortho_study_successor_unique UNIQUE(predecessor_id),
  CONSTRAINT ortho_study_documentation_unique UNIQUE(documented_from_id),
  CONSTRAINT ortho_study_first CHECK((version=1)=(predecessor_id IS NULL)),
  CONSTRAINT ortho_study_no_self CHECK(predecessor_id IS DISTINCT FROM id AND documented_from_id IS DISTINCT FROM id AND base_documented_id IS DISTINCT FROM id),
  CONSTRAINT ortho_study_documented_from CHECK((kind='documented')=(documented_from_id IS NOT NULL)),
  CONSTRAINT ortho_study_predecessor_fk FOREIGN KEY(ortho_case_id,predecessor_id)
    REFERENCES ortho_case_study_revisions(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ortho_study_documented_from_fk FOREIGN KEY(ortho_case_id,documented_from_id)
    REFERENCES ortho_case_study_revisions(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ortho_study_base_fk FOREIGN KEY(ortho_case_id,base_documented_id)
    REFERENCES ortho_case_study_revisions(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ortho_study_patient_case_idx ON ortho_case_study_revisions(patient_id,ortho_case_id,version DESC);
CREATE FUNCTION reject_ortho_study_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- TRUNCATE already owns ACCESS EXCLUSIVE, so an empty reset cannot race INSERT.
  IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_case_study_revisions) THEN RETURN NULL; END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'patient_id')=(to_jsonb(OLD)-'patient_id') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Orthodontic study history is append-only' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER ortho_study_immutable BEFORE UPDATE OR DELETE ON ortho_case_study_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_ortho_study_mutation();
CREATE TRIGGER ortho_study_no_truncate BEFORE TRUNCATE ON ortho_case_study_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ortho_study_mutation();
CREATE FUNCTION check_ortho_study_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r ortho_case_study_revisions%ROWTYPE; previous ortho_case_study_revisions%ROWTYPE; base ortho_case_study_revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM ortho_case_study_revisions WHERE id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Study revision missing' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.ortho_case_id=o.id
    WHERE o.id=r.ortho_case_id AND c.id=r.clinical_case_id AND o.patient_id=r.patient_id AND c.patient_id=r.patient_id AND c.specialty='orthodontics') THEN
    RAISE EXCEPTION 'Study ownership must match both cases' USING ERRCODE='23514';
  END IF;
  IF r.predecessor_id IS NOT NULL THEN
    SELECT * INTO previous FROM ortho_case_study_revisions WHERE id=r.predecessor_id;
    IF NOT FOUND OR previous.ortho_case_id<>r.ortho_case_id OR previous.clinical_case_id<>r.clinical_case_id OR previous.version<>r.version-1 THEN
      RAISE EXCEPTION 'Study predecessor must be the exact prior case version' USING ERRCODE='23514';
    END IF;
  END IF;
  IF r.base_documented_id IS NOT NULL THEN
    SELECT * INTO base FROM ortho_case_study_revisions WHERE id=r.base_documented_id;
    IF NOT FOUND OR base.kind<>'documented' OR base.ortho_case_id<>r.ortho_case_id OR base.clinical_case_id<>r.clinical_case_id OR base.version>=r.version THEN
      RAISE EXCEPTION 'Study base must be an earlier documented case revision' USING ERRCODE='23514';
    END IF;
  END IF;
  IF r.kind='documented' THEN
    IF r.predecessor_id IS NULL OR previous.kind<>'draft' OR r.documented_from_id<>previous.id
      OR r.content IS DISTINCT FROM previous.content OR r.content_sha256 IS DISTINCT FROM previous.content_sha256
      OR r.base_documented_id IS DISTINCT FROM previous.base_documented_id THEN
      RAISE EXCEPTION 'Documentation must copy the exact immediately preceding draft' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ortho_study_final_state AFTER INSERT OR UPDATE ON ortho_case_study_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_study_final_state();
-- Parent ownership changes must preserve every saved revision's case/bridge scope.
-- Deferred checks allow the existing atomic canonical patient merge to move all FKs.
CREATE FUNCTION check_ortho_study_parent_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ortho_case_study_revisions r
    JOIN ortho_cases o ON o.id=r.ortho_case_id JOIN clinical_cases c ON c.id=r.clinical_case_id
    WHERE ((TG_TABLE_NAME='ortho_cases' AND r.ortho_case_id=NEW.id)
      OR (TG_TABLE_NAME='clinical_cases' AND r.clinical_case_id=NEW.id))
      AND (o.patient_id<>r.patient_id OR c.patient_id<>r.patient_id
        OR c.ortho_case_id IS DISTINCT FROM o.id OR c.specialty<>'orthodontics')) THEN
    RAISE EXCEPTION 'Study ownership must match both cases' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ortho_study_case_scope AFTER UPDATE ON ortho_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_study_parent_scope();
CREATE CONSTRAINT TRIGGER ortho_study_bridge_scope AFTER UPDATE ON clinical_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_study_parent_scope();
`;

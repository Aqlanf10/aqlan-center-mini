CREATE TABLE ortho_facial_revisions (
 id SERIAL PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
 recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
 ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
 clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
 document_id INTEGER NOT NULL REFERENCES patient_documents(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>0),
 previous_revision_id INTEGER REFERENCES ortho_facial_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_by TEXT NOT NULL CHECK(length(btrim(created_by)) BETWEEN 1 AND 200),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
 command JSONB NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2097152),
 results JSONB NOT NULL CHECK(jsonb_typeof(results)='object' AND octet_length(results::text)<=2097152),
 UNIQUE(ortho_case_id,document_id,version),
 UNIQUE(previous_revision_id),
 CHECK(previous_revision_id IS DISTINCT FROM id),
 UNIQUE(ortho_case_id,actor_user_id,command_id),
 CHECK((version=1)=(previous_revision_id IS NULL))
);
CREATE INDEX ortho_facial_revisions_patient_idx ON ortho_facial_revisions(patient_id,ortho_case_id,document_id);
CREATE FUNCTION reject_ortho_facial_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_facial_revisions) THEN RETURN NULL; END IF;
 -- Canonical patient merge may update the live FK, never the recorded identity.
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'patient_id')=(to_jsonb(OLD)-'patient_id') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Facial review history is append-only' USING ERRCODE='55000';
END; $$;
CREATE TRIGGER ortho_facial_no_truncate BEFORE TRUNCATE ON ortho_facial_revisions
 FOR EACH STATEMENT EXECUTE FUNCTION reject_ortho_facial_mutation();
CREATE TRIGGER ortho_facial_revisions_immutable BEFORE UPDATE OR DELETE ON ortho_facial_revisions
 FOR EACH ROW EXECUTE FUNCTION reject_ortho_facial_mutation();
CREATE FUNCTION check_ortho_facial_revision_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ortho_facial_revisions' THEN
  -- Hold parent ownership witnesses through commit, including direct SQL writers.
  -- Deferred checks read final state to support atomic merges and reverse-order restore.
  PERFORM d.id FROM patient_documents d JOIN ortho_facial_revisions r ON r.document_id=d.id WHERE r.id=NEW.id FOR SHARE OF d;
  PERFORM o.id FROM ortho_cases o JOIN ortho_facial_revisions r ON r.ortho_case_id=o.id WHERE r.id=NEW.id FOR SHARE OF o;
  PERFORM c.id FROM clinical_cases c JOIN ortho_facial_revisions r ON r.clinical_case_id=c.id WHERE r.id=NEW.id FOR SHARE OF c;
 END IF;
 IF EXISTS(SELECT 1 FROM ortho_facial_revisions r
  JOIN ortho_cases o ON o.id=r.ortho_case_id JOIN clinical_cases c ON c.id=r.clinical_case_id
  JOIN patient_documents d ON d.id=r.document_id
  LEFT JOIN ortho_facial_revisions p ON p.id=r.previous_revision_id
  WHERE ((TG_TABLE_NAME='ortho_facial_revisions' AND r.id=NEW.id)
   OR (TG_TABLE_NAME='ortho_cases' AND r.ortho_case_id=NEW.id)
   OR (TG_TABLE_NAME='clinical_cases' AND r.clinical_case_id=NEW.id)
   OR (TG_TABLE_NAME='patient_documents' AND r.document_id=NEW.id))
  AND (r.patient_id<>o.patient_id OR r.patient_id<>c.patient_id OR r.patient_id<>d.patient_id
   OR c.specialty<>'orthodontics' OR c.ortho_case_id IS DISTINCT FROM r.ortho_case_id OR d.ortho_case_id IS DISTINCT FROM r.ortho_case_id
   OR (r.previous_revision_id IS NOT NULL AND (p.id IS NULL OR p.patient_id<>r.patient_id OR p.ortho_case_id<>r.ortho_case_id OR p.clinical_case_id<>r.clinical_case_id OR p.document_id<>r.document_id OR p.version<>r.version-1)))) THEN
  RAISE EXCEPTION 'Facial revision ownership and predecessor must match' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER ortho_facial_revision_scope AFTER INSERT OR UPDATE ON ortho_facial_revisions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_facial_revision_scope();
CREATE CONSTRAINT TRIGGER ortho_facial_case_scope AFTER UPDATE ON ortho_cases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_facial_revision_scope();
CREATE CONSTRAINT TRIGGER ortho_facial_bridge_scope AFTER UPDATE ON clinical_cases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_facial_revision_scope();
CREATE CONSTRAINT TRIGGER ortho_facial_document_scope AFTER UPDATE ON patient_documents
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_facial_revision_scope();

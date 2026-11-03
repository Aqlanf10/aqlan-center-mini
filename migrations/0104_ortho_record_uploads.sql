CREATE TABLE ortho_record_uploads (
 id SERIAL PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
 recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
 ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
 clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
 document_id INTEGER NOT NULL UNIQUE REFERENCES patient_documents(id) ON DELETE RESTRICT,
 actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_by TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 command JSONB NOT NULL CHECK(jsonb_typeof(command)='object'),
 UNIQUE(patient_id,actor_user_id,command_id)
);
CREATE TRIGGER ortho_record_uploads_immutable BEFORE UPDATE OR DELETE ON ortho_record_uploads
 FOR EACH ROW EXECUTE FUNCTION reject_ortho_journey_mutation();
CREATE FUNCTION check_ortho_record_upload_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM ortho_record_uploads r JOIN ortho_cases o ON o.id=r.ortho_case_id
 JOIN clinical_cases c ON c.id=r.clinical_case_id JOIN patient_documents d ON d.id=r.document_id
 WHERE ((TG_TABLE_NAME='ortho_record_uploads' AND r.id=NEW.id) OR (TG_TABLE_NAME='ortho_cases' AND r.ortho_case_id=NEW.id)
 OR (TG_TABLE_NAME='clinical_cases' AND r.clinical_case_id=NEW.id) OR (TG_TABLE_NAME='patient_documents' AND r.document_id=NEW.id))
 AND (r.patient_id<>o.patient_id OR r.patient_id<>c.patient_id OR r.patient_id<>d.patient_id
 OR c.ortho_case_id IS DISTINCT FROM r.ortho_case_id OR d.ortho_case_id IS DISTINCT FROM r.ortho_case_id
 OR d.sha256 IS DISTINCT FROM r.command->'file'->>'sha256'
 OR d.mime_type IS DISTINCT FROM r.command->'file'->>'mimeType'
 OR d.size_bytes IS DISTINCT FROM (r.command->'file'->>'sizeBytes')::bigint
 OR d.title IS DISTINCT FROM btrim(r.command->>'title')
 OR d.photo_view IS DISTINCT FROM r.command->>'photoView'
 OR d.photo_stage IS DISTINCT FROM r.command->>'photoStage'
 OR d.taken_on IS DISTINCT FROM (r.command->'occurrence'->>'takenOn')::date)) THEN
 RAISE EXCEPTION 'Orthodontic upload source or ownership changed' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER ortho_record_upload_scope AFTER INSERT OR UPDATE ON ortho_record_uploads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_record_upload_scope();
CREATE CONSTRAINT TRIGGER ortho_record_upload_case_scope AFTER UPDATE ON ortho_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_record_upload_scope();
CREATE CONSTRAINT TRIGGER ortho_record_upload_bridge_scope AFTER UPDATE ON clinical_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_record_upload_scope();
CREATE CONSTRAINT TRIGGER ortho_record_upload_document_scope AFTER UPDATE ON patient_documents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_record_upload_scope();

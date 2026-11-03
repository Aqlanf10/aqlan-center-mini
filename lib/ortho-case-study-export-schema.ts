/** Export portion of reserved0053. A manifest is immutable and belongs to one
 * exact saved draft/documented revision. Artifact progress is append-only. */
export const ORTHO_CASE_STUDY_EXPORT_SQL = `
CREATE TABLE IF NOT EXISTS ortho_case_study_export_manifests (
 id SERIAL PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
 recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
 ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
 clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
 study_revision_id INTEGER NOT NULL,
 study_kind TEXT NOT NULL CHECK(study_kind IN ('draft','documented')),
 study_sha256 TEXT NOT NULL CHECK(study_sha256 ~ '^[a-f0-9]{64}$'),
 actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
 rendering_contract_sha256 TEXT NOT NULL CHECK(rendering_contract_sha256 ~ '^[a-f0-9]{64}$'),
 formats TEXT[] NOT NULL CHECK(formats=ARRAY['pptx']::text[] OR formats=ARRAY['pdf']::text[] OR formats=ARRAY['pptx','pdf']::text[]),
 content JSONB NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=8388608),
 UNIQUE(ortho_case_id,id), UNIQUE(ortho_case_id,actor_user_id,command_id),
 FOREIGN KEY(ortho_case_id,study_revision_id) REFERENCES ortho_case_study_revisions(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS ortho_study_exports_patient_case_idx ON ortho_case_study_export_manifests(patient_id,ortho_case_id,id DESC);
CREATE TABLE IF NOT EXISTS ortho_case_study_artifact_events (
 id SERIAL PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
 recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
 ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
 clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
 manifest_id INTEGER NOT NULL,
 manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 rendering_contract_sha256 TEXT NOT NULL CHECK(rendering_contract_sha256 ~ '^[a-f0-9]{64}$'),
 format TEXT NOT NULL CHECK(format IN ('pptx','pdf')),
 version INTEGER NOT NULL CHECK(version>0), predecessor_id INTEGER,
 attempt_id UUID NOT NULL,
 attempt_actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
 transition TEXT NOT NULL CHECK(transition IN ('queued','claimed','renewed','failed','expired','completed')),
 command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 lease_token UUID, lease_until TIMESTAMPTZ(3), operation_deadline TIMESTAMPTZ(3),
 failure_code TEXT CHECK(failure_code IN ('render_failed','capability_unavailable','resource_limit','authority_retired','lease_expired','output_invalid')),
 storage_key TEXT, file_sha256 TEXT, size_bytes INTEGER, mime_type TEXT,
 UNIQUE(manifest_id,format,version), UNIQUE(manifest_id,format,id), UNIQUE(predecessor_id),
 UNIQUE(manifest_id,format,actor_user_id,command_id),
 CHECK((version=1)=(predecessor_id IS NULL)), CHECK(predecessor_id IS DISTINCT FROM id),
 CHECK(transition='expired' OR actor_user_id=attempt_actor_user_id),
 CHECK((transition='queued' AND lease_token IS NULL AND lease_until IS NULL AND operation_deadline IS NULL)
    OR (transition<>'queued' AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND operation_deadline IS NOT NULL AND lease_until<=operation_deadline)),
 CHECK((transition IN ('failed','expired'))=(failure_code IS NOT NULL)),
 CHECK(transition<>'expired' OR failure_code='lease_expired'),
 CHECK((transition='completed' AND storage_key IS NOT NULL AND file_sha256 IS NOT NULL AND size_bytes IS NOT NULL AND mime_type IS NOT NULL AND file_sha256 ~ '^[a-f0-9]{64}$'
    AND size_bytes BETWEEN 1 AND 33554432 AND mime_type=CASE WHEN format='pdf' THEN 'application/pdf' ELSE 'application/vnd.openxmlformats-officedocument.presentationml.presentation' END
    AND storage_key=substr(file_sha256,1,2)||'/'||substr(file_sha256,3,2)||'/'||file_sha256||'.'||format)
   OR (transition<>'completed' AND storage_key IS NULL AND file_sha256 IS NULL AND size_bytes IS NULL AND mime_type IS NULL)),
 FOREIGN KEY(ortho_case_id,manifest_id) REFERENCES ortho_case_study_export_manifests(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(manifest_id,format,predecessor_id) REFERENCES ortho_case_study_artifact_events(manifest_id,format,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS ortho_study_artifact_attempt_root_idx ON ortho_case_study_artifact_events(attempt_id) WHERE transition='queued';
CREATE INDEX IF NOT EXISTS ortho_study_artifact_patient_case_idx ON ortho_case_study_artifact_events(patient_id,ortho_case_id,manifest_id,format,version);
CREATE OR REPLACE FUNCTION reject_ortho_study_export_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'patient_id')=(to_jsonb(OLD)-'patient_id') THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Orthodontic export evidence is append-only' USING ERRCODE='55000';
END; $$;
CREATE OR REPLACE FUNCTION check_ortho_study_manifest_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m ortho_case_study_export_manifests%ROWTYPE; s ortho_case_study_revisions%ROWTYPE;
BEGIN
 SELECT * INTO m FROM ortho_case_study_export_manifests WHERE id=NEW.id;
 SELECT * INTO s FROM ortho_case_study_revisions WHERE id=m.study_revision_id;
 IF s.id IS NULL OR s.patient_id<>m.patient_id OR s.ortho_case_id<>m.ortho_case_id OR s.clinical_case_id<>m.clinical_case_id
   OR s.kind<>m.study_kind OR s.content_sha256<>m.study_sha256 THEN
  RAISE EXCEPTION 'Export requires its exact saved study revision' USING ERRCODE='23514';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.ortho_case_id=o.id
    WHERE o.id=m.ortho_case_id AND c.id=m.clinical_case_id AND o.patient_id=m.patient_id AND c.patient_id=m.patient_id) THEN
  RAISE EXCEPTION 'Export ownership must match both cases' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE OR REPLACE FUNCTION check_ortho_study_artifact_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r ortho_case_study_artifact_events%ROWTYPE; p ortho_case_study_artifact_events%ROWTYPE; m ortho_case_study_export_manifests%ROWTYPE;
BEGIN
 SELECT * INTO r FROM ortho_case_study_artifact_events WHERE id=NEW.id;
 SELECT * INTO m FROM ortho_case_study_export_manifests WHERE id=r.manifest_id;
 IF m.id IS NULL OR r.patient_id<>m.patient_id OR r.ortho_case_id<>m.ortho_case_id OR r.clinical_case_id<>m.clinical_case_id
   OR r.manifest_sha256<>m.content_sha256 OR r.rendering_contract_sha256<>m.rendering_contract_sha256 OR NOT(r.format=ANY(m.formats)) THEN
  RAISE EXCEPTION 'Artifact must bind exact manifest scope' USING ERRCODE='23514';
 END IF;
 IF r.predecessor_id IS NOT NULL THEN
  SELECT * INTO p FROM ortho_case_study_artifact_events WHERE id=r.predecessor_id;
  IF p.id IS NULL OR p.manifest_id<>r.manifest_id OR p.format<>r.format OR p.version<>r.version-1 OR r.created_at<p.created_at THEN
   RAISE EXCEPTION 'Artifact requires contiguous monotonic lineage' USING ERRCODE='23514';
  END IF;
 END IF;
 IF r.transition='queued' THEN
  IF r.version>1 AND p.transition NOT IN ('failed','expired') THEN RAISE EXCEPTION 'Only a terminal unsuccessful attempt may retry' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ortho_case_study_artifact_events next WHERE next.predecessor_id=r.id AND next.transition='claimed') THEN
   RAISE EXCEPTION 'An artifact queue and claim must commit together' USING ERRCODE='23514';
  END IF;
 ELSE
  IF p.id IS NULL OR r.attempt_id<>p.attempt_id OR r.attempt_actor_user_id<>p.attempt_actor_user_id THEN
   RAISE EXCEPTION 'Artifact attempt identity changed' USING ERRCODE='23514';
  END IF;
  IF r.transition='claimed' THEN
   IF p.transition<>'queued' OR r.lease_until<=r.created_at OR r.operation_deadline<=r.created_at OR r.operation_deadline>r.created_at+interval '15 minutes' THEN
    RAISE EXCEPTION 'Invalid artifact claim' USING ERRCODE='23514';
   END IF;
  ELSE
   IF p.transition NOT IN ('claimed','renewed') OR r.lease_token IS DISTINCT FROM p.lease_token OR r.operation_deadline IS DISTINCT FROM p.operation_deadline THEN
    RAISE EXCEPTION 'Artifact lease was lost' USING ERRCODE='23514';
   END IF;
   IF r.transition='renewed' THEN
    IF r.created_at>=p.lease_until OR r.lease_until<=p.lease_until THEN RAISE EXCEPTION 'Invalid artifact renewal' USING ERRCODE='23514'; END IF;
   ELSE
    IF r.lease_until IS DISTINCT FROM p.lease_until THEN RAISE EXCEPTION 'Terminal artifact lease changed' USING ERRCODE='23514'; END IF;
    IF (r.transition='expired' AND r.created_at<p.lease_until) OR (r.transition<>'expired' AND r.created_at>=p.lease_until) THEN
     RAISE EXCEPTION 'Artifact terminal transition violates lease time' USING ERRCODE='23514';
    END IF;
   END IF;
  END IF;
 END IF;
 RETURN NULL;
END; $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_case_study_export_manifests'::regclass AND tgname='ortho_study_manifest_immutable' AND NOT tgisinternal) THEN
  CREATE TRIGGER ortho_study_manifest_immutable BEFORE UPDATE OR DELETE ON ortho_case_study_export_manifests FOR EACH ROW EXECUTE FUNCTION reject_ortho_study_export_mutation();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_case_study_export_manifests'::regclass AND tgname='ortho_study_manifest_final_state' AND NOT tgisinternal) THEN
  CREATE CONSTRAINT TRIGGER ortho_study_manifest_final_state AFTER INSERT OR UPDATE ON ortho_case_study_export_manifests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_study_manifest_final_state();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_case_study_artifact_events'::regclass AND tgname='ortho_study_artifact_immutable' AND NOT tgisinternal) THEN
  CREATE TRIGGER ortho_study_artifact_immutable BEFORE UPDATE OR DELETE ON ortho_case_study_artifact_events FOR EACH ROW EXECUTE FUNCTION reject_ortho_study_export_mutation();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_case_study_artifact_events'::regclass AND tgname='ortho_study_artifact_final_state' AND NOT tgisinternal) THEN
  CREATE CONSTRAINT TRIGGER ortho_study_artifact_final_state AFTER INSERT OR UPDATE ON ortho_case_study_artifact_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_study_artifact_final_state();
 END IF;
END; $$;
`;

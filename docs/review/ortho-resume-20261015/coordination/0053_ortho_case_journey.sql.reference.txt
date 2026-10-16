-- Unpublished reserved0053: documentary decisions, physical retention events, saved studies and export evidence.
-- No backfilled clinical facts, automatic consent, treatment, appointments or financial writes.
CREATE TABLE IF NOT EXISTS ortho_decision_revisions (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK(schema_version=1),
  version INTEGER NOT NULL CHECK(version>0), predecessor_id INTEGER,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL CHECK(length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  recording_context TEXT NOT NULL CONSTRAINT ortho_journey_recording_context_check CHECK(recording_context IN ('current','retrospective')),
  case_status_at_capture TEXT NOT NULL CONSTRAINT ortho_journey_capture_status_check CHECK(case_status_at_capture IN ('active','retention','completed','discontinued')),
  command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  content JSONB NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=2097152),
  UNIQUE(ortho_case_id,version), UNIQUE(ortho_case_id,id), UNIQUE(ortho_case_id,actor_user_id,command_id), UNIQUE(predecessor_id),
  CHECK((version=1)=(predecessor_id IS NULL)), CHECK(predecessor_id IS DISTINCT FROM id),
  CONSTRAINT ortho_journey_context_status_check CHECK((recording_context='retrospective')=(case_status_at_capture IN ('completed','discontinued'))),
  FOREIGN KEY(ortho_case_id,predecessor_id) REFERENCES ortho_decision_revisions(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS ortho_retention_entries (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK(schema_version=1),
  version INTEGER NOT NULL CHECK(version>0), predecessor_id INTEGER,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL CHECK(length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  recording_context TEXT NOT NULL CONSTRAINT ortho_journey_recording_context_check CHECK(recording_context IN ('current','retrospective')),
  case_status_at_capture TEXT NOT NULL CONSTRAINT ortho_journey_capture_status_check CHECK(case_status_at_capture IN ('active','retention','completed','discontinued')),
  command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  content JSONB NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=2097152),
  UNIQUE(ortho_case_id,version), UNIQUE(ortho_case_id,id), UNIQUE(ortho_case_id,actor_user_id,command_id), UNIQUE(predecessor_id),
  CHECK((version=1)=(predecessor_id IS NULL)), CHECK(predecessor_id IS DISTINCT FROM id),
  CONSTRAINT ortho_journey_context_status_check CHECK((recording_context='retrospective')=(case_status_at_capture IN ('completed','discontinued'))),
  arch TEXT NOT NULL CHECK(arch IN ('upper','lower','legacy_unknown')),
  entry_kind TEXT NOT NULL CHECK(entry_kind IN ('debond','device_delivery','device_review','device_repair','device_replacement','device_status_change','followup_intent')),
  supersedes_entry_id INTEGER, device_entry_id INTEGER, replaces_device_id INTEGER, expected_device_revision_id INTEGER,
  UNIQUE(supersedes_entry_id),
  CHECK(supersedes_entry_id IS DISTINCT FROM id AND device_entry_id IS DISTINCT FROM id AND replaces_device_id IS DISTINCT FROM id AND expected_device_revision_id IS DISTINCT FROM id),
  CHECK((entry_kind='device_replacement')=(replaces_device_id IS NOT NULL)),
  CHECK((COALESCE(device_entry_id,replaces_device_id) IS NULL)=(expected_device_revision_id IS NULL)),
  CHECK(device_entry_id IS NULL OR entry_kind IN ('device_review','device_repair','device_status_change','followup_intent')),
  CHECK(entry_kind NOT IN ('device_review','device_repair','device_status_change') OR device_entry_id IS NOT NULL),
  FOREIGN KEY(ortho_case_id,predecessor_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(ortho_case_id,supersedes_entry_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(ortho_case_id,device_entry_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(ortho_case_id,replaces_device_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(ortho_case_id,expected_device_revision_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS ortho_retention_one_physical_replacement_idx ON ortho_retention_entries(replaces_device_id)
  WHERE entry_kind='device_replacement' AND supersedes_entry_id IS NULL;
CREATE OR REPLACE FUNCTION reject_ortho_journey_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'patient_id')=(to_jsonb(OLD)-'patient_id') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Orthodontic documentary history is append-only' USING ERRCODE='55000';
END; $$;
CREATE OR REPLACE FUNCTION check_ortho_journey_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r RECORD; previous RECORD;
BEGIN
  IF TG_TABLE_NAME NOT IN ('ortho_decision_revisions','ortho_retention_entries') THEN RAISE EXCEPTION 'Invalid journey relation'; END IF;
  EXECUTE format('SELECT * FROM %I WHERE id=$1',TG_TABLE_NAME) INTO r USING NEW.id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Journey revision missing' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.ortho_case_id=o.id
    WHERE o.id=r.ortho_case_id AND c.id=r.clinical_case_id AND o.patient_id=r.patient_id AND c.patient_id=r.patient_id) THEN
    RAISE EXCEPTION 'Journey ownership must match both cases' USING ERRCODE='23514';
  END IF;
  IF r.predecessor_id IS NOT NULL THEN
    EXECUTE format('SELECT * FROM %I WHERE id=$1',TG_TABLE_NAME) INTO previous USING r.predecessor_id;
    IF previous.id IS NULL OR previous.ortho_case_id<>r.ortho_case_id OR previous.clinical_case_id<>r.clinical_case_id OR previous.version<>r.version-1 THEN
      RAISE EXCEPTION 'Journey predecessor must be exact prior case version' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END; $$;

CREATE INDEX IF NOT EXISTS ortho_decision_revisions_patient_case_idx ON ortho_decision_revisions(patient_id,ortho_case_id,version DESC);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_decision_revisions'::regclass AND tgname='ortho_decision_revisions_immutable' AND NOT tgisinternal) THEN
  CREATE TRIGGER ortho_decision_revisions_immutable BEFORE UPDATE OR DELETE ON ortho_decision_revisions FOR EACH ROW EXECUTE FUNCTION reject_ortho_journey_mutation();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_decision_revisions'::regclass AND tgname='ortho_decision_revisions_final_state' AND NOT tgisinternal) THEN
  CREATE CONSTRAINT TRIGGER ortho_decision_revisions_final_state AFTER INSERT OR UPDATE ON ortho_decision_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_journey_final_state();
 END IF;
END; $$;

CREATE INDEX IF NOT EXISTS ortho_retention_entries_patient_case_idx ON ortho_retention_entries(patient_id,ortho_case_id,version DESC);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_retention_entries'::regclass AND tgname='ortho_retention_entries_immutable' AND NOT tgisinternal) THEN
  CREATE TRIGGER ortho_retention_entries_immutable BEFORE UPDATE OR DELETE ON ortho_retention_entries FOR EACH ROW EXECUTE FUNCTION reject_ortho_journey_mutation();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_retention_entries'::regclass AND tgname='ortho_retention_entries_final_state' AND NOT tgisinternal) THEN
  CREATE CONSTRAINT TRIGGER ortho_retention_entries_final_state AFTER INSERT OR UPDATE ON ortho_retention_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_journey_final_state();
 END IF;
END; $$;
CREATE OR REPLACE FUNCTION check_ortho_retention_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r ortho_retention_entries%ROWTYPE; original ortho_retention_entries%ROWTYPE; device ortho_retention_entries%ROWTYPE; witness ortho_retention_entries%ROWTYPE; target_id INTEGER;
BEGIN
 SELECT * INTO r FROM ortho_retention_entries WHERE id=NEW.id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Retention entry missing' USING ERRCODE='23514'; END IF;
 IF r.arch IS DISTINCT FROM r.content->>'arch' OR r.entry_kind IS DISTINCT FROM r.content->'payload'->>'kind'
   OR r.supersedes_entry_id IS DISTINCT FROM (r.content->>'supersedesEntryId')::integer
   OR r.device_entry_id IS DISTINCT FROM (r.content->'payload'->'device'->>'deviceId')::integer
   OR r.replaces_device_id IS DISTINCT FROM (r.content->'payload'->'replaces'->>'deviceId')::integer
   OR r.expected_device_revision_id IS DISTINCT FROM COALESCE((r.content->'payload'->'device'->>'expectedDeviceRevisionId')::integer,(r.content->'payload'->'replaces'->>'expectedDeviceRevisionId')::integer) THEN
  RAISE EXCEPTION 'Retention columns do not match immutable content' USING ERRCODE='23514';
 END IF;
 IF r.supersedes_entry_id IS NOT NULL THEN
  SELECT * INTO original FROM ortho_retention_entries WHERE id=r.supersedes_entry_id;
  IF NOT FOUND OR original.ortho_case_id<>r.ortho_case_id OR original.clinical_case_id<>r.clinical_case_id OR original.version>=r.version
    OR original.entry_kind<>r.entry_kind OR original.device_entry_id IS DISTINCT FROM r.device_entry_id OR original.replaces_device_id IS DISTINCT FROM r.replaces_device_id
    OR ((original.arch<>r.arch) IS DISTINCT FROM (r.content->>'archCorrectionReason' IS NOT NULL)) THEN
   RAISE EXCEPTION 'Retention correction changes physical identity or has invalid lineage' USING ERRCODE='23514';
  END IF;
 ELSIF r.content->>'archCorrectionReason' IS NOT NULL THEN
  RAISE EXCEPTION 'An arch correction requires an earlier event' USING ERRCODE='23514';
 END IF;
 target_id=COALESCE(r.device_entry_id,r.replaces_device_id);
 IF target_id IS NOT NULL THEN
  SELECT * INTO device FROM ortho_retention_entries WHERE id=target_id;
  IF NOT FOUND OR device.ortho_case_id<>r.ortho_case_id OR device.clinical_case_id<>r.clinical_case_id OR device.version>=r.version
    OR device.entry_kind NOT IN ('device_delivery','device_replacement') OR device.supersedes_entry_id IS NOT NULL THEN
   RAISE EXCEPTION 'Retention target must be an earlier physical device root' USING ERRCODE='23514';
  END IF;
  SELECT * INTO witness FROM ortho_retention_entries WHERE id=r.expected_device_revision_id;
  IF NOT FOUND OR witness.ortho_case_id<>r.ortho_case_id OR witness.clinical_case_id<>r.clinical_case_id OR witness.version>=r.version THEN
   RAISE EXCEPTION 'Retention expected device witness must precede the event' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END; $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_retention_entries'::regclass AND tgname='ortho_retention_physical_integrity' AND NOT tgisinternal) THEN
  CREATE CONSTRAINT TRIGGER ortho_retention_physical_integrity AFTER INSERT OR UPDATE ON ortho_retention_entries
   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_final_state();
 END IF;
END; $$;
CREATE TABLE IF NOT EXISTS ortho_case_study_revisions (
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
CREATE INDEX IF NOT EXISTS ortho_study_patient_case_idx ON ortho_case_study_revisions(patient_id,ortho_case_id,version DESC);
CREATE OR REPLACE FUNCTION reject_ortho_study_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'patient_id')=(to_jsonb(OLD)-'patient_id') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Orthodontic study history is append-only' USING ERRCODE='55000';
END;
$$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_case_study_revisions'::regclass AND tgname='ortho_study_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER ortho_study_immutable BEFORE UPDATE OR DELETE ON ortho_case_study_revisions FOR EACH ROW EXECUTE FUNCTION reject_ortho_study_mutation();
  END IF;
END; $$;
CREATE OR REPLACE FUNCTION check_ortho_study_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r ortho_case_study_revisions%ROWTYPE; previous ortho_case_study_revisions%ROWTYPE; base ortho_case_study_revisions%ROWTYPE;
BEGIN
  SELECT * INTO r FROM ortho_case_study_revisions WHERE id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Study revision missing' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.ortho_case_id=o.id
    WHERE o.id=r.ortho_case_id AND c.id=r.clinical_case_id AND o.patient_id=r.patient_id AND c.patient_id=r.patient_id) THEN
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
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_case_study_revisions'::regclass AND tgname='ortho_study_final_state' AND NOT tgisinternal) THEN
    CREATE CONSTRAINT TRIGGER ortho_study_final_state AFTER INSERT OR UPDATE ON ortho_case_study_revisions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_study_final_state();
  END IF;
END; $$;

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


/** Documentary decision/retention portion of unpublished reserved0053.
 * Physical replacement roots are distinct from append-only fact corrections. */
const common = `
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
  CONSTRAINT ortho_journey_context_status_check CHECK((recording_context='retrospective')=(case_status_at_capture IN ('completed','discontinued')))`;
const decisions = `CREATE TABLE IF NOT EXISTS ortho_decision_revisions (${common},
  FOREIGN KEY(ortho_case_id,predecessor_id) REFERENCES ortho_decision_revisions(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);`;
const retention = `CREATE TABLE IF NOT EXISTS ortho_retention_entries (${common},
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
  WHERE entry_kind='device_replacement' AND supersedes_entry_id IS NULL;`;
const immutable = `CREATE OR REPLACE FUNCTION reject_ortho_journey_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
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
END; $$;`;
const triggers = (["ortho_decision_revisions", "ortho_retention_entries"] as const).map(table => `
CREATE INDEX IF NOT EXISTS ${table}_patient_case_idx ON ${table}(patient_id,ortho_case_id,version DESC);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='${table}'::regclass AND tgname='${table}_immutable' AND NOT tgisinternal) THEN
  CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_ortho_journey_mutation();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='${table}'::regclass AND tgname='${table}_final_state' AND NOT tgisinternal) THEN
  CREATE CONSTRAINT TRIGGER ${table}_final_state AFTER INSERT OR UPDATE ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_journey_final_state();
 END IF;
END; $$;`).join("\n");
const retentionIntegrity = `CREATE OR REPLACE FUNCTION check_ortho_retention_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
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
END; $$;`;
export const ORTHO_CASE_JOURNEY_RECORD_SQL = `${decisions}\n${retention}\n${immutable}\n${triggers}\n${retentionIntegrity}`;

-- Immutable documentary retention events. No lifecycle, scheduling or financial action.
CREATE TABLE ortho_retention_entries (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0 AND recorded_patient_id=patient_id),
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
  UNIQUE(patient_id,actor_user_id,command_id), UNIQUE(ortho_case_id,version), UNIQUE(ortho_case_id,id), UNIQUE(ortho_case_id,actor_user_id,command_id), UNIQUE(predecessor_id),
  CHECK((version=1)=(predecessor_id IS NULL)), CHECK(predecessor_id IS DISTINCT FROM id),
  CONSTRAINT ortho_journey_context_status_check CHECK((recording_context='retrospective')=(case_status_at_capture IN ('completed','discontinued'))),
 arch TEXT NOT NULL CHECK(arch IN ('upper','lower','legacy_unknown')),
 entry_kind TEXT NOT NULL CHECK(entry_kind IN ('debond','device_delivery','device_replacement','device_review','device_repair','device_status_change','followup_intent')),
 supersedes_entry_id INTEGER UNIQUE, device_entry_id INTEGER, replaces_device_id INTEGER, expected_device_revision_id INTEGER,
 CHECK(arch IS NOT DISTINCT FROM content->>'arch'),
 CHECK(entry_kind IS NOT DISTINCT FROM content->'payload'->>'kind'),
 CHECK(supersedes_entry_id IS NOT DISTINCT FROM (content->>'supersedesEntryId')::integer),
 CHECK(device_entry_id IS NOT DISTINCT FROM (content->'payload'->'device'->>'deviceId')::integer),
 CHECK(replaces_device_id IS NOT DISTINCT FROM (content->'payload'->'replaces'->>'deviceId')::integer),
 CHECK(expected_device_revision_id IS NOT DISTINCT FROM coalesce((content->'payload'->'device'->>'expectedDeviceRevisionId')::integer,(content->'payload'->'replaces'->>'expectedDeviceRevisionId')::integer)),
 CHECK(content ?& ARRAY['arch','supersedesEntryId','archCorrectionReason','payload'] AND jsonb_typeof(content->'payload')='object'),
 CHECK((content - ARRAY['arch','supersedesEntryId','archCorrectionReason','payload']='{}'::jsonb)
   OR (content ?& ARRAY['savedVersion','documentWitnesses'] AND content->'savedVersion'='2'::jsonb AND jsonb_typeof(content->'documentWitnesses')='array'
     AND content - ARRAY['arch','supersedesEntryId','archCorrectionReason','payload','savedVersion','documentWitnesses']='{}'::jsonb)),
 CHECK((entry_kind='device_replacement')=(replaces_device_id IS NOT NULL)),
 CHECK((entry_kind IN ('device_review','device_repair','device_status_change') AND device_entry_id IS NOT NULL)
   OR (entry_kind='followup_intent') OR (entry_kind NOT IN ('device_review','device_repair','device_status_change','followup_intent') AND device_entry_id IS NULL)),
 CHECK((expected_device_revision_id IS NOT NULL)=(device_entry_id IS NOT NULL OR replaces_device_id IS NOT NULL)),
 CHECK(content->'archCorrectionReason'='null'::jsonb OR (supersedes_entry_id IS NOT NULL AND length(btrim(content->>'archCorrectionReason')) BETWEEN 1 AND 500)),
 FOREIGN KEY(ortho_case_id,predecessor_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(ortho_case_id,supersedes_entry_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(ortho_case_id,device_entry_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(ortho_case_id,replaces_device_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(ortho_case_id,expected_device_revision_id) REFERENCES ortho_retention_entries(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX ortho_retention_patient_case_idx ON ortho_retention_entries(patient_id,ortho_case_id,version DESC);
CREATE FUNCTION reject_ortho_retention_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_retention_entries) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'Retention ledger is append-only' USING ERRCODE='55000';
END; $$;
CREATE TRIGGER ortho_retention_no_truncate BEFORE TRUNCATE ON ortho_retention_entries FOR EACH STATEMENT EXECUTE FUNCTION reject_ortho_retention_mutation();
CREATE TRIGGER ortho_retention_immutable BEFORE UPDATE OR DELETE ON ortho_retention_entries FOR EACH ROW EXECUTE FUNCTION reject_ortho_retention_mutation();
CREATE FUNCTION check_ortho_retention_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved ortho_retention_entries%ROWTYPE; root_id INTEGER; head_id INTEGER; delivery_arch TEXT;
BEGIN
 IF TG_TABLE_NAME='ortho_retention_entries' THEN
  PERFORM id FROM ortho_cases WHERE id=NEW.ortho_case_id FOR SHARE;
  PERFORM id FROM clinical_cases WHERE id=NEW.clinical_case_id FOR SHARE;
 END IF;
 IF EXISTS(SELECT 1 FROM ortho_retention_entries r
 LEFT JOIN ortho_cases o ON o.id=r.ortho_case_id LEFT JOIN clinical_cases c ON c.id=r.clinical_case_id
 LEFT JOIN ortho_retention_entries previous ON previous.id=r.predecessor_id
 LEFT JOIN ortho_retention_entries corrected ON corrected.id=r.supersedes_entry_id
 LEFT JOIN ortho_retention_entries device ON device.id=coalesce(r.device_entry_id,r.replaces_device_id)
 LEFT JOIN ortho_retention_entries revision ON revision.id=r.expected_device_revision_id
 WHERE ((TG_TABLE_NAME='ortho_retention_entries' AND r.id=NEW.id)
 OR (TG_TABLE_NAME='ortho_cases' AND r.ortho_case_id=NEW.id)
 OR (TG_TABLE_NAME='clinical_cases' AND r.clinical_case_id=NEW.id))
 AND (r.patient_id IS DISTINCT FROM o.patient_id OR r.patient_id IS DISTINCT FROM c.patient_id
 OR c.ortho_case_id IS DISTINCT FROM r.ortho_case_id OR c.specialty IS DISTINCT FROM 'orthodontics'
 OR (r.predecessor_id IS NOT NULL AND (previous.version IS DISTINCT FROM r.version-1 OR previous.clinical_case_id IS DISTINCT FROM r.clinical_case_id))
 OR (r.supersedes_entry_id IS NOT NULL AND (corrected.entry_kind IS DISTINCT FROM r.entry_kind OR corrected.version>=r.version
   OR ((corrected.arch IS DISTINCT FROM r.arch) IS DISTINCT FROM (r.content->'archCorrectionReason'<>'null'::jsonb))
   OR corrected.device_entry_id IS DISTINCT FROM r.device_entry_id OR corrected.replaces_device_id IS DISTINCT FROM r.replaces_device_id))
 OR (r.expected_device_revision_id IS NOT NULL AND (device.entry_kind NOT IN ('device_delivery','device_replacement')
   OR device.supersedes_entry_id IS NOT NULL OR device.version>=r.version OR revision.version>=r.version
   OR revision.arch IS DISTINCT FROM r.arch)))) THEN
 RAISE EXCEPTION 'Orthodontic retention ownership or lineage changed' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME='ortho_retention_entries' THEN
  SELECT * INTO saved FROM ortho_retention_entries WHERE id=NEW.id;
  -- Compute documentary roots from case-version order, never serial-ID chronology.
  IF saved.expected_device_revision_id IS NOT NULL THEN
   WITH RECURSIVE ancestry AS (
    SELECT id AS leaf,id,supersedes_entry_id,version FROM ortho_retention_entries WHERE ortho_case_id=saved.ortho_case_id AND version<saved.version
    UNION ALL SELECT c.leaf,p.id,p.supersedes_entry_id,p.version FROM ancestry c
      JOIN ortho_retention_entries p ON p.id=c.supersedes_entry_id AND p.version<c.version
   ), roots AS (SELECT leaf,id AS root FROM ancestry WHERE supersedes_entry_id IS NULL)
   SELECT e.id INTO head_id FROM ortho_retention_entries e JOIN roots ON roots.leaf=e.id
    WHERE e.ortho_case_id=saved.ortho_case_id AND e.version<saved.version
     AND (e.device_entry_id=coalesce(saved.device_entry_id,saved.replaces_device_id)
       OR e.replaces_device_id=coalesce(saved.device_entry_id,saved.replaces_device_id)
       OR roots.root=coalesce(saved.device_entry_id,saved.replaces_device_id))
    ORDER BY e.version DESC LIMIT 1;
   WITH RECURSIVE corrections AS (
    SELECT id,arch,version FROM ortho_retention_entries WHERE id=coalesce(saved.device_entry_id,saved.replaces_device_id)
    UNION ALL SELECT e.id,e.arch,e.version FROM ortho_retention_entries e JOIN corrections c ON e.supersedes_entry_id=c.id
      WHERE e.version<saved.version AND e.version>c.version
   ) SELECT arch INTO delivery_arch FROM corrections ORDER BY version DESC LIMIT 1;
   IF head_id IS DISTINCT FROM saved.expected_device_revision_id OR delivery_arch IS DISTINCT FROM saved.arch THEN
    RAISE EXCEPTION 'Retention device revision must be the latest event for its device' USING ERRCODE='23514';
   END IF;
  END IF;
  IF saved.replaces_device_id IS NOT NULL THEN
   WITH RECURSIVE chain AS (
    SELECT id,supersedes_entry_id,version FROM ortho_retention_entries WHERE id=saved.id
    UNION ALL SELECT p.id,p.supersedes_entry_id,p.version FROM ortho_retention_entries p JOIN chain c ON p.id=c.supersedes_entry_id AND p.version<c.version
   ) SELECT id INTO root_id FROM chain WHERE supersedes_entry_id IS NULL;
   IF EXISTS(SELECT 1 FROM ortho_retention_entries p WHERE p.ortho_case_id=saved.ortho_case_id
     AND p.version<saved.version AND p.replaces_device_id=saved.replaces_device_id AND p.supersedes_entry_id IS NULL AND p.id<>root_id) THEN
    RAISE EXCEPTION 'Retention device already has a replacement' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER ortho_retention_scope_entries AFTER INSERT OR UPDATE ON ortho_retention_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_scope();
CREATE CONSTRAINT TRIGGER ortho_retention_scope_cases AFTER UPDATE ON ortho_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_scope();
CREATE CONSTRAINT TRIGGER ortho_retention_scope_bridges AFTER UPDATE ON clinical_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_scope();

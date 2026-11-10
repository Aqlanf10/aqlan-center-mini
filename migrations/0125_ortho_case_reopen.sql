-- Explicit clinical reopening. Existing closure facts remain untouched on upgrade.
ALTER TABLE ortho_cases ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_version>=0);
CREATE TABLE ortho_case_reopen_events (
 id SERIAL PRIMARY KEY,
 patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
 recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id=patient_id),
 ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
 clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
 actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_by TEXT NOT NULL CHECK(length(btrim(created_by)) BETWEEN 1 AND 200),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 command_id TEXT NOT NULL CHECK(command_id ~ '^[A-Za-z0-9_-]{16,80}$'),
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 command JSONB NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=8192),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 before_version INTEGER NOT NULL CHECK(before_version>=0),
 after_version INTEGER NOT NULL CHECK(after_version=before_version+1),
 previous_status TEXT NOT NULL CHECK(previous_status IN ('completed','discontinued')),
 previous_phase TEXT NOT NULL CHECK(previous_phase IN ('assessment','aligning','working','finishing','retention')),
 previous_closed_at TIMESTAMPTZ,
 previous_closed_by TEXT,
 previous_closed_note TEXT,
 target_status TEXT NOT NULL CHECK(target_status IN ('assessment','active','retention')),
 UNIQUE(patient_id,actor_user_id,command_id),
 UNIQUE(ortho_case_id,after_version),
 CHECK((previous_phase='assessment')=(target_status='assessment')),
 CHECK(previous_phase<>'assessment' OR previous_status='discontinued'),
 CHECK(coalesce(command ?& ARRAY['schemaVersion','clientRequestId','expectedLifecycleVersion','expectedStatus','targetStatus','reason']
   AND command - ARRAY['schemaVersion','clientRequestId','expectedLifecycleVersion','expectedStatus','targetStatus','reason']='{}'::jsonb
   AND command->'schemaVersion'='1'::jsonb
   AND command->>'clientRequestId'=command_id
   AND command->'expectedLifecycleVersion'=to_jsonb(before_version)
   AND command->>'expectedStatus'=previous_status
   AND command->>'targetStatus'=target_status AND command->>'reason'=reason,false))
);
CREATE INDEX ortho_reopen_case_history_idx ON ortho_case_reopen_events(patient_id,ortho_case_id,id DESC);
CREATE FUNCTION reject_ortho_reopen_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_case_reopen_events) THEN RETURN NULL; END IF;
 RAISE EXCEPTION 'Orthodontic reopen history is immutable' USING ERRCODE='55000';
END; $$;
CREATE TRIGGER ortho_reopen_immutable BEFORE UPDATE OR DELETE ON ortho_case_reopen_events FOR EACH ROW EXECUTE FUNCTION reject_ortho_reopen_mutation();
CREATE TRIGGER ortho_reopen_no_truncate BEFORE TRUNCATE ON ortho_case_reopen_events FOR EACH STATEMENT EXECUTE FUNCTION reject_ortho_reopen_mutation();

CREATE FUNCTION guard_ortho_lifecycle_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Existing close writers participate in CAS without changing their permissions.
 NEW.lifecycle_version:=OLD.lifecycle_version;
 IF ROW(NEW.status,NEW.closed_at,NEW.closed_by,NEW.closed_note) IS DISTINCT FROM ROW(OLD.status,OLD.closed_at,OLD.closed_by,OLD.closed_note) THEN
  NEW.lifecycle_version:=OLD.lifecycle_version+1;
 END IF;
 IF OLD.status IN ('completed','discontinued') AND NEW.status IN ('assessment','active','retention') THEN
  IF NEW.closed_at IS NOT NULL OR NEW.closed_by IS NOT NULL OR NEW.closed_note IS NOT NULL
   OR (to_jsonb(NEW)-ARRAY['status','closed_at','closed_by','closed_note','lifecycle_version'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','closed_at','closed_by','closed_note','lifecycle_version'])
   OR NOT EXISTS(SELECT 1 FROM ortho_case_reopen_events e WHERE e.ortho_case_id=OLD.id
     AND e.patient_id=OLD.patient_id AND e.before_version=OLD.lifecycle_version AND e.after_version=NEW.lifecycle_version
     AND e.previous_status=OLD.status AND e.previous_phase=OLD.phase AND e.target_status=NEW.status
     AND e.previous_closed_at IS NOT DISTINCT FROM OLD.closed_at
     AND e.previous_closed_by IS NOT DISTINCT FROM OLD.closed_by
     AND e.previous_closed_note IS NOT DISTINCT FROM OLD.closed_note) THEN
   RAISE EXCEPTION 'Reopening requires exact preserved closure evidence and unchanged treatment data' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER ortho_lifecycle_transition BEFORE UPDATE ON ortho_cases FOR EACH ROW EXECUTE FUNCTION guard_ortho_lifecycle_transition();

CREATE FUNCTION check_ortho_reopen_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ortho_case_reopen_events' THEN
  PERFORM id FROM ortho_cases WHERE id=NEW.ortho_case_id FOR SHARE;
  PERFORM id FROM clinical_cases WHERE id=NEW.clinical_case_id FOR SHARE;
 END IF;
 IF EXISTS(SELECT 1 FROM ortho_case_reopen_events e
   LEFT JOIN ortho_cases o ON o.id=e.ortho_case_id LEFT JOIN clinical_cases c ON c.id=e.clinical_case_id
   WHERE ((TG_TABLE_NAME='ortho_case_reopen_events' AND e.id=NEW.id)
     OR (TG_TABLE_NAME='ortho_cases' AND e.ortho_case_id=NEW.id)
     OR (TG_TABLE_NAME='clinical_cases' AND e.clinical_case_id=NEW.id))
   AND (o.id IS NULL OR c.id IS NULL OR o.patient_id IS DISTINCT FROM e.patient_id OR c.patient_id IS DISTINCT FROM e.patient_id
     OR c.ortho_case_id IS DISTINCT FROM e.ortho_case_id OR c.specialty IS DISTINCT FROM 'orthodontics'
     OR o.lifecycle_version<e.after_version
     OR (o.lifecycle_version=e.after_version AND (o.status IS DISTINCT FROM e.target_status
       OR o.closed_at IS NOT NULL OR o.closed_by IS NOT NULL OR o.closed_note IS NOT NULL)))) THEN
  RAISE EXCEPTION 'Reopen receipt ownership or committed lifecycle changed' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
-- Deferred checks preserve history when restoring the complete final snapshot.
CREATE CONSTRAINT TRIGGER ortho_reopen_scope AFTER INSERT ON ortho_case_reopen_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_reopen_scope();
CREATE CONSTRAINT TRIGGER ortho_reopen_case_scope AFTER UPDATE ON ortho_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_reopen_scope();
CREATE CONSTRAINT TRIGGER ortho_reopen_bridge_scope AFTER UPDATE ON clinical_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_reopen_scope();

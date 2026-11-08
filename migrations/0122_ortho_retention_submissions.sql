CREATE TABLE ortho_retention_submissions (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0 AND recorded_patient_id=patient_id),
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  command JSONB CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2097152),
  state TEXT NOT NULL CHECK(state IN ('pending','committed','cancelled')),
  entry_id INTEGER REFERENCES ortho_retention_entries(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  CONSTRAINT ortho_retention_submission_command_unique UNIQUE(ortho_case_id,actor_user_id,command_id),
  CONSTRAINT ortho_retention_submission_patient_command_unique UNIQUE(patient_id,actor_user_id,command_id),
  CONSTRAINT ortho_retention_submission_state CHECK(
    (state='pending' AND command IS NOT NULL
      AND entry_id IS NULL AND settled_at IS NULL AND acknowledged_at IS NULL)
    OR (state='committed' AND entry_id IS NOT NULL AND settled_at IS NOT NULL)
    OR (state='cancelled' AND entry_id IS NULL AND settled_at IS NOT NULL)),
  CONSTRAINT ortho_retention_submission_payload CHECK(
    (acknowledged_at IS NOT NULL AND command IS NULL)
    OR (acknowledged_at IS NULL AND ((command IS NOT NULL)
      OR (state='cancelled' AND command IS NULL)))),
  CONSTRAINT ortho_retention_submission_times CHECK(
    (settled_at IS NULL OR settled_at>=created_at)
    AND (acknowledged_at IS NULL OR acknowledged_at>=settled_at))
);
-- Terminal outcomes continue blocking a new submission until explicitly acknowledged.
CREATE UNIQUE INDEX ortho_retention_submission_unacknowledged_unique
  ON ortho_retention_submissions(ortho_case_id) WHERE acknowledged_at IS NULL;
CREATE INDEX ortho_retention_submission_patient_case_idx ON ortho_retention_submissions(patient_id,ortho_case_id);
CREATE FUNCTION guard_ortho_retention_submission_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- TRUNCATE already owns ACCESS EXCLUSIVE, so an empty reset cannot race INSERT.
  IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_retention_submissions) THEN RETURN NULL; END IF;
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Orthodontic retention submissions cannot be erased' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','entry_id','settled_at','acknowledged_at','command'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','entry_id','settled_at','acknowledged_at','command']) THEN
    RAISE EXCEPTION 'Orthodontic retention submission identity is immutable' USING ERRCODE='55000';
  END IF;
  IF (OLD.state='pending' AND NEW.state='committed')
    OR (OLD.state='committed' AND OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL) THEN
    -- Revalidate restored committed intent on acknowledgement too.
    -- Validate before acknowledgement can scrub the deferred check's payload.
    -- Normal execution inserts the outcome before settling. Committed INSERT
    -- during reverse-order restore is checked by the deferred final-state guard.
    IF NOT EXISTS(SELECT 1 FROM ortho_retention_entries r WHERE r.id=NEW.entry_id
      AND r.patient_id=OLD.patient_id AND r.recorded_patient_id=OLD.recorded_patient_id
      AND r.ortho_case_id=OLD.ortho_case_id AND r.clinical_case_id=OLD.clinical_case_id
      AND r.actor_user_id=OLD.actor_user_id AND r.command_id=OLD.command_id
      AND r.request_fingerprint=OLD.request_fingerprint
      AND OLD.command->'schemaVersion'='2'::jsonb AND r.content->'savedVersion'='2'::jsonb
      AND OLD.command->>'clientRequestId'=OLD.command_id
      AND OLD.command->'content'=r.content->'payload'
      AND OLD.command->'arch'=r.content->'arch'
      AND OLD.command->'supersedesEntryId'=r.content->'supersedesEntryId'
      AND OLD.command->'archCorrectionReason'=r.content->'archCorrectionReason'
      AND OLD.command->'expectedDocuments'=r.content->'documentWitnesses'
      AND OLD.command->>'reason'=r.reason
      AND OLD.command->'expectedHeadId'=coalesce(to_jsonb(r.predecessor_id),'null'::jsonb)) THEN
      RAISE EXCEPTION 'Committed retention submission must match its exact entry' USING ERRCODE='23514';
    END IF;
  END IF;
  IF OLD.state='pending' THEN
    IF NEW.acknowledged_at IS NOT NULL OR (NEW.state='pending'
      AND (NEW.entry_id IS NOT NULL OR NEW.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'Pending retention submission cannot be acknowledged' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
    OR NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
    RAISE EXCEPTION 'Settled retention submission cannot be changed or reopened' USING ERRCODE='55000';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
    RAISE EXCEPTION 'Retention submission acknowledgement is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.command IS DISTINCT FROM OLD.command AND NOT (
    OLD.state<>'pending' AND OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL AND NEW.command IS NULL) THEN
    RAISE EXCEPTION 'Retention submission payload is immutable until acknowledgement' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ortho_retention_submission_immutable BEFORE UPDATE OR DELETE ON ortho_retention_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_ortho_retention_submission_mutation();
CREATE TRIGGER ortho_retention_submission_no_truncate BEFORE TRUNCATE ON ortho_retention_submissions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ortho_retention_submission_mutation();
CREATE FUNCTION check_ortho_retention_submission_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s ortho_retention_submissions%ROWTYPE; r ortho_retention_entries%ROWTYPE;
BEGIN
  -- Parent row locks prevent ownership write skew; the shared patient/actor/command fence serializes
  -- deferred cross-table checks even when the opposite row is not visible yet.
  PERFORM id FROM ortho_cases WHERE id=NEW.ortho_case_id FOR SHARE;
  PERFORM id FROM clinical_cases WHERE id=NEW.clinical_case_id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('ortho-retention-submission:' || NEW.patient_id::text || ':' || NEW.actor_user_id::text || ':' || NEW.command_id, 0));
  IF TG_TABLE_NAME='ortho_retention_entries' THEN
    SELECT * INTO s FROM ortho_retention_submissions
      WHERE patient_id=NEW.patient_id AND actor_user_id=NEW.actor_user_id AND command_id=NEW.command_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Retention entry requires a committed reservation' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO s FROM ortho_retention_submissions WHERE id=NEW.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Retention submission missing' USING ERRCODE='23514'; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.id=s.clinical_case_id
    WHERE o.id=s.ortho_case_id AND o.patient_id=s.patient_id AND c.patient_id=s.patient_id
      AND c.ortho_case_id=o.id AND c.specialty='orthodontics') THEN
    RAISE EXCEPTION 'Retention submission ownership must match both cases' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='ortho_retention_submissions' THEN
   IF NEW.state='committed' AND NEW.command IS NOT NULL THEN
    -- Validate the captured committed row image, not only the possibly scrubbed final row.
    s.command := NEW.command;
   END IF;
  END IF;
  SELECT * INTO r FROM ortho_retention_entries
    WHERE patient_id=s.patient_id AND actor_user_id=s.actor_user_id AND command_id=s.command_id;
  IF s.state='committed' THEN
    IF NOT FOUND OR r.id IS DISTINCT FROM s.entry_id OR r.patient_id<>s.patient_id
      OR r.ortho_case_id<>s.ortho_case_id OR r.clinical_case_id<>s.clinical_case_id OR r.recorded_patient_id<>s.recorded_patient_id
      OR r.request_fingerprint<>s.request_fingerprint
      OR (s.command IS NOT NULL AND (
        s.command->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR r.content->'savedVersion' IS DISTINCT FROM '2'::jsonb
        OR s.command->>'clientRequestId' IS DISTINCT FROM s.command_id
        OR s.command->'content' IS DISTINCT FROM r.content->'payload'
        OR s.command->'arch' IS DISTINCT FROM r.content->'arch'
        OR s.command->'supersedesEntryId' IS DISTINCT FROM r.content->'supersedesEntryId'
        OR s.command->'archCorrectionReason' IS DISTINCT FROM r.content->'archCorrectionReason'
        OR s.command->'expectedDocuments' IS DISTINCT FROM r.content->'documentWitnesses'
        OR s.command->>'reason' IS DISTINCT FROM r.reason
        OR s.command->'expectedHeadId' IS DISTINCT FROM coalesce(to_jsonb(r.predecessor_id),'null'::jsonb))) THEN
      RAISE EXCEPTION 'Committed retention submission must match its exact entry' USING ERRCODE='23514';
    END IF;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'Uncommitted retention submission cannot have a saved entry' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
-- Deferred checks support reverse physical restore order without relaxing immutable patient ownership.
CREATE CONSTRAINT TRIGGER ortho_retention_submission_final_state AFTER INSERT OR UPDATE ON ortho_retention_submissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_submission_final_state();
CREATE CONSTRAINT TRIGGER ortho_retention_submission_review_scope AFTER INSERT OR UPDATE ON ortho_retention_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_submission_final_state();
CREATE FUNCTION check_ortho_retention_submission_parent_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ortho_retention_submissions s
    JOIN ortho_cases o ON o.id=s.ortho_case_id JOIN clinical_cases c ON c.id=s.clinical_case_id
    WHERE ((TG_TABLE_NAME='ortho_cases' AND s.ortho_case_id=NEW.id)
      OR (TG_TABLE_NAME='clinical_cases' AND s.clinical_case_id=NEW.id))
      AND (o.patient_id<>s.patient_id OR c.patient_id<>s.patient_id
        OR c.ortho_case_id IS DISTINCT FROM o.id OR c.specialty<>'orthodontics')) THEN
    RAISE EXCEPTION 'Retention submission ownership must match both cases' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ortho_retention_submission_case_scope AFTER UPDATE ON ortho_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_submission_parent_scope();
CREATE CONSTRAINT TRIGGER ortho_retention_submission_bridge_scope AFTER UPDATE ON clinical_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_retention_submission_parent_scope();

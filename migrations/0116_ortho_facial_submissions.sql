CREATE TABLE ortho_facial_submissions (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  document_id INTEGER REFERENCES patient_documents(id) ON DELETE RESTRICT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  command JSONB CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2097152),
  previous_version INTEGER CHECK(previous_version>=0),
  state TEXT NOT NULL CHECK(state IN ('pending','committed','cancelled')),
  revision_id INTEGER REFERENCES ortho_facial_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  CONSTRAINT ortho_facial_submission_command_unique UNIQUE(ortho_case_id,actor_user_id,command_id),
  CONSTRAINT ortho_facial_submission_state CHECK(
    (state='pending' AND command IS NOT NULL AND previous_version IS NOT NULL
      AND revision_id IS NULL AND settled_at IS NULL AND acknowledged_at IS NULL)
    OR (state='committed' AND previous_version IS NOT NULL AND revision_id IS NOT NULL AND settled_at IS NOT NULL)
    OR (state='cancelled' AND revision_id IS NULL AND settled_at IS NOT NULL)),
  CONSTRAINT ortho_facial_submission_payload CHECK(
    (acknowledged_at IS NOT NULL AND command IS NULL)
    OR (acknowledged_at IS NULL AND ((command IS NOT NULL AND previous_version IS NOT NULL)
      OR (state='cancelled' AND command IS NULL AND previous_version IS NULL)))),
  CONSTRAINT ortho_facial_submission_document CHECK(document_id IS NOT NULL
    OR (state='cancelled' AND command IS NULL AND previous_version IS NULL)),
  CONSTRAINT ortho_facial_submission_times CHECK(
    (settled_at IS NULL OR settled_at>=created_at)
    AND (acknowledged_at IS NULL OR acknowledged_at>=settled_at))
);
-- Terminal outcomes continue blocking a new submission until explicitly acknowledged.
CREATE UNIQUE INDEX ortho_facial_submission_unacknowledged_unique
  ON ortho_facial_submissions(ortho_case_id) WHERE acknowledged_at IS NULL;
CREATE INDEX ortho_facial_submission_patient_case_idx ON ortho_facial_submissions(patient_id,ortho_case_id);
CREATE FUNCTION guard_ortho_facial_submission_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- TRUNCATE already owns ACCESS EXCLUSIVE, so an empty reset cannot race INSERT.
  IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_facial_submissions) THEN RETURN NULL; END IF;
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Orthodontic facial submissions cannot be erased' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['patient_id','state','revision_id','settled_at','acknowledged_at','command'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['patient_id','state','revision_id','settled_at','acknowledged_at','command']) THEN
    RAISE EXCEPTION 'Orthodontic facial submission identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.state='pending' THEN
    IF NEW.acknowledged_at IS NOT NULL OR (NEW.state='pending'
      AND (NEW.revision_id IS NOT NULL OR NEW.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'Pending facial submission cannot be acknowledged' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
    RAISE EXCEPTION 'Settled facial submission cannot be changed or reopened' USING ERRCODE='55000';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
    RAISE EXCEPTION 'Facial submission acknowledgement is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.command IS DISTINCT FROM OLD.command AND NOT (
    OLD.state<>'pending' AND OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL AND NEW.command IS NULL) THEN
    RAISE EXCEPTION 'Facial submission payload is immutable until acknowledgement' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ortho_facial_submission_immutable BEFORE UPDATE OR DELETE ON ortho_facial_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_ortho_facial_submission_mutation();
CREATE TRIGGER ortho_facial_submission_no_truncate BEFORE TRUNCATE ON ortho_facial_submissions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ortho_facial_submission_mutation();
CREATE FUNCTION check_ortho_facial_submission_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s ortho_facial_submissions%ROWTYPE; r ortho_facial_revisions%ROWTYPE;
BEGIN
  -- Parent row locks prevent ownership write skew; the shared case fence serializes
  -- deferred cross-table checks even when the opposite row is not visible yet.
  PERFORM id FROM patient_documents WHERE id=NEW.document_id FOR SHARE;
  PERFORM id FROM ortho_cases WHERE id=NEW.ortho_case_id FOR SHARE;
  PERFORM id FROM clinical_cases WHERE id=NEW.clinical_case_id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('ortho-facial-submission:' || NEW.ortho_case_id::text, 0));
  IF TG_TABLE_NAME='ortho_facial_revisions' THEN
    SELECT * INTO s FROM ortho_facial_submissions
      WHERE ortho_case_id=NEW.ortho_case_id AND actor_user_id=NEW.actor_user_id AND command_id=NEW.command_id;
    -- Historical revisions predate the submission journal and remain valid.
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    SELECT * INTO s FROM ortho_facial_submissions WHERE id=NEW.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Facial submission missing' USING ERRCODE='23514'; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.id=s.clinical_case_id
    LEFT JOIN patient_documents d ON d.id=s.document_id
    WHERE o.id=s.ortho_case_id AND o.patient_id=s.patient_id AND c.patient_id=s.patient_id AND (s.document_id IS NULL OR d.patient_id=s.patient_id)
      AND ((s.state='cancelled' AND s.acknowledged_at IS NOT NULL)
        OR (c.ortho_case_id=o.id AND c.specialty='orthodontics' AND (s.document_id IS NULL OR d.ortho_case_id=o.id)))) THEN
    RAISE EXCEPTION 'Facial submission ownership must match both cases' USING ERRCODE='23514';
  END IF;
  SELECT * INTO r FROM ortho_facial_revisions
    WHERE ortho_case_id=s.ortho_case_id AND actor_user_id=s.actor_user_id AND command_id=s.command_id;
  IF s.state='committed' THEN
    IF NOT FOUND OR r.id IS DISTINCT FROM s.revision_id OR r.patient_id<>s.patient_id
      OR r.clinical_case_id<>s.clinical_case_id OR r.document_id IS DISTINCT FROM s.document_id
      OR (s.command IS NOT NULL AND r.command IS DISTINCT FROM s.command)
      OR r.request_fingerprint<>s.request_fingerprint OR r.version::bigint<>s.previous_version::bigint+1 THEN
      RAISE EXCEPTION 'Committed facial submission must match its exact revision' USING ERRCODE='23514';
    END IF;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'Uncommitted facial submission cannot have a saved revision' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
-- Deferred checks support reverse physical restore order and atomic patient merges.
CREATE CONSTRAINT TRIGGER ortho_facial_submission_final_state AFTER INSERT OR UPDATE ON ortho_facial_submissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_facial_submission_final_state();
CREATE CONSTRAINT TRIGGER ortho_facial_submission_revision_scope AFTER INSERT OR UPDATE ON ortho_facial_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_facial_submission_final_state();
CREATE FUNCTION check_ortho_facial_submission_parent_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ortho_facial_submissions s
    JOIN ortho_cases o ON o.id=s.ortho_case_id JOIN clinical_cases c ON c.id=s.clinical_case_id
    LEFT JOIN patient_documents d ON d.id=s.document_id
    WHERE ((TG_TABLE_NAME='ortho_cases' AND s.ortho_case_id=NEW.id)
      OR (TG_TABLE_NAME='clinical_cases' AND s.clinical_case_id=NEW.id)
      OR (TG_TABLE_NAME='patient_documents' AND s.document_id=NEW.id))
      AND (o.patient_id<>s.patient_id OR c.patient_id<>s.patient_id OR (s.document_id IS NOT NULL AND d.patient_id<>s.patient_id)
        OR (NOT (s.state='cancelled' AND s.acknowledged_at IS NOT NULL)
          AND (c.ortho_case_id IS DISTINCT FROM o.id OR c.specialty<>'orthodontics' OR (s.document_id IS NOT NULL AND d.ortho_case_id IS DISTINCT FROM o.id))))) THEN
    RAISE EXCEPTION 'Facial submission ownership must match both cases' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ortho_facial_submission_case_scope AFTER UPDATE ON ortho_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_facial_submission_parent_scope();
CREATE CONSTRAINT TRIGGER ortho_facial_submission_bridge_scope AFTER UPDATE ON clinical_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_facial_submission_parent_scope();
CREATE CONSTRAINT TRIGGER ortho_facial_submission_document_scope AFTER UPDATE ON patient_documents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_facial_submission_parent_scope();

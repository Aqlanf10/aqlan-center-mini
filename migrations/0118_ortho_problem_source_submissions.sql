CREATE TABLE ortho_problem_source_submissions (
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
  review_id INTEGER REFERENCES ortho_problem_source_reviews(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  CONSTRAINT ortho_problem_source_submission_command_unique UNIQUE(ortho_case_id,actor_user_id,command_id),
  CONSTRAINT ortho_problem_source_submission_patient_command_unique UNIQUE(patient_id,actor_user_id,command_id),
  CONSTRAINT ortho_problem_source_submission_state CHECK(
    (state='pending' AND command IS NOT NULL
      AND review_id IS NULL AND settled_at IS NULL AND acknowledged_at IS NULL)
    OR (state='committed' AND review_id IS NOT NULL AND settled_at IS NOT NULL)
    OR (state='cancelled' AND review_id IS NULL AND settled_at IS NOT NULL)),
  CONSTRAINT ortho_problem_source_submission_payload CHECK(
    (acknowledged_at IS NOT NULL AND command IS NULL)
    OR (acknowledged_at IS NULL AND ((command IS NOT NULL)
      OR (state='cancelled' AND command IS NULL)))),
  CONSTRAINT ortho_problem_source_submission_times CHECK(
    (settled_at IS NULL OR settled_at>=created_at)
    AND (acknowledged_at IS NULL OR acknowledged_at>=settled_at))
);
-- Terminal outcomes continue blocking a new submission until explicitly acknowledged.
CREATE UNIQUE INDEX ortho_problem_source_submission_unacknowledged_unique
  ON ortho_problem_source_submissions(ortho_case_id) WHERE acknowledged_at IS NULL;
CREATE INDEX ortho_problem_source_submission_patient_case_idx ON ortho_problem_source_submissions(patient_id,ortho_case_id);
CREATE FUNCTION guard_ortho_problem_source_submission_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- TRUNCATE already owns ACCESS EXCLUSIVE, so an empty reset cannot race INSERT.
  IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_problem_source_submissions) THEN RETURN NULL; END IF;
  IF TG_OP<>'UPDATE' THEN
    RAISE EXCEPTION 'Orthodontic problem source submissions cannot be erased' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','review_id','settled_at','acknowledged_at','command'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','review_id','settled_at','acknowledged_at','command']) THEN
    RAISE EXCEPTION 'Orthodontic problem source submission identity is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.state='pending' THEN
    IF NEW.acknowledged_at IS NOT NULL OR (NEW.state='pending'
      AND (NEW.review_id IS NOT NULL OR NEW.settled_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'Pending problem source submission cannot be acknowledged' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.state IS DISTINCT FROM OLD.state OR NEW.review_id IS DISTINCT FROM OLD.review_id
    OR NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
    RAISE EXCEPTION 'Settled problem source submission cannot be changed or reopened' USING ERRCODE='55000';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
    RAISE EXCEPTION 'Problem source submission acknowledgement is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.command IS DISTINCT FROM OLD.command AND NOT (
    OLD.state<>'pending' AND OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL AND NEW.command IS NULL) THEN
    RAISE EXCEPTION 'Problem source submission payload is immutable until acknowledgement' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ortho_problem_source_submission_immutable BEFORE UPDATE OR DELETE ON ortho_problem_source_submissions
  FOR EACH ROW EXECUTE FUNCTION guard_ortho_problem_source_submission_mutation();
CREATE TRIGGER ortho_problem_source_submission_no_truncate BEFORE TRUNCATE ON ortho_problem_source_submissions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ortho_problem_source_submission_mutation();
CREATE FUNCTION check_ortho_problem_source_submission_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s ortho_problem_source_submissions%ROWTYPE; r ortho_problem_source_reviews%ROWTYPE;
BEGIN
  -- Parent row locks prevent ownership write skew; the shared patient/actor/command fence serializes
  -- deferred cross-table checks even when the opposite row is not visible yet.
  PERFORM id FROM ortho_cases WHERE id=NEW.ortho_case_id FOR SHARE;
  PERFORM id FROM clinical_cases WHERE id=NEW.clinical_case_id FOR SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('ortho-problem_source-submission:' || NEW.patient_id::text || ':' || NEW.actor_user_id::text || ':' || NEW.command_id, 0));
  IF TG_TABLE_NAME='ortho_problem_source_reviews' THEN
    SELECT * INTO s FROM ortho_problem_source_submissions
      WHERE patient_id=NEW.patient_id AND actor_user_id=NEW.actor_user_id AND command_id=NEW.command_id;
    -- Historical reviews predate the submission journal and remain valid.
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    SELECT * INTO s FROM ortho_problem_source_submissions WHERE id=NEW.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Problem source submission missing' USING ERRCODE='23514'; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.id=s.clinical_case_id
    WHERE o.id=s.ortho_case_id AND o.patient_id=s.patient_id AND c.patient_id=s.patient_id
      AND c.ortho_case_id=o.id AND c.specialty='orthodontics') THEN
    RAISE EXCEPTION 'Problem source submission ownership must match both cases' USING ERRCODE='23514';
  END IF;
  SELECT * INTO r FROM ortho_problem_source_reviews
    WHERE patient_id=s.patient_id AND actor_user_id=s.actor_user_id AND command_id=s.command_id;
  IF s.state='committed' THEN
    IF NOT FOUND OR r.id IS DISTINCT FROM s.review_id OR r.patient_id<>s.patient_id
      OR r.ortho_case_id<>s.ortho_case_id OR r.clinical_case_id<>s.clinical_case_id OR r.recorded_patient_id<>s.recorded_patient_id
      OR r.request_fingerprint<>s.request_fingerprint
      OR (s.command IS NOT NULL AND (
        s.command->>'schemaVersion' IS DISTINCT FROM '1'
        OR s.command->>'clinicianReviewed' IS DISTINCT FROM 'true'
        OR s.command->>'commandId' IS DISTINCT FROM s.command_id
        OR s.command->'source' IS DISTINCT FROM r.source_snapshot->'ref'
        OR s.command->'source'->>'version' IS DISTINCT FROM r.source_version
        OR (s.command->'source'->>'kind' || ':' || CASE WHEN s.command->'source'->>'kind'='ceph_diagnosis'
          THEN s.command->'source'->>'id' || ':' ELSE '' END || (s.command->'source'->>'member')) IS DISTINCT FROM r.source_identity
        OR s.command->>'reason' IS DISTINCT FROM r.reason
        OR s.command->'expectedReviewId' IS DISTINCT FROM coalesce(to_jsonb(r.supersedes_review_id),'null'::jsonb)
        OR NOT coalesce((s.command->>'action'='create' AND s.command->'problemId'='null'::jsonb
          AND btrim(s.command->>'label', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')=r.problem_label)
          OR (s.command->>'action'='link' AND s.command->'problemId'=to_jsonb(r.problem_id)
            AND s.command->'label'='null'::jsonb),false))) THEN
      RAISE EXCEPTION 'Committed problem source submission must match its exact review' USING ERRCODE='23514';
    END IF;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'Uncommitted problem source submission cannot have a saved review' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
-- Deferred checks support reverse physical restore order without relaxing immutable patient ownership.
CREATE CONSTRAINT TRIGGER ortho_problem_source_submission_final_state AFTER INSERT OR UPDATE ON ortho_problem_source_submissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_problem_source_submission_final_state();
CREATE CONSTRAINT TRIGGER ortho_problem_source_submission_review_scope AFTER INSERT OR UPDATE ON ortho_problem_source_reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_problem_source_submission_final_state();
CREATE FUNCTION check_ortho_problem_source_submission_parent_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ortho_problem_source_submissions s
    JOIN ortho_cases o ON o.id=s.ortho_case_id JOIN clinical_cases c ON c.id=s.clinical_case_id
    WHERE ((TG_TABLE_NAME='ortho_cases' AND s.ortho_case_id=NEW.id)
      OR (TG_TABLE_NAME='clinical_cases' AND s.clinical_case_id=NEW.id))
      AND (o.patient_id<>s.patient_id OR c.patient_id<>s.patient_id
        OR c.ortho_case_id IS DISTINCT FROM o.id OR c.specialty<>'orthodontics')) THEN
    RAISE EXCEPTION 'Problem source submission ownership must match both cases' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ortho_problem_source_submission_case_scope AFTER UPDATE ON ortho_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_problem_source_submission_parent_scope();
CREATE CONSTRAINT TRIGGER ortho_problem_source_submission_bridge_scope AFTER UPDATE ON clinical_cases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_problem_source_submission_parent_scope();

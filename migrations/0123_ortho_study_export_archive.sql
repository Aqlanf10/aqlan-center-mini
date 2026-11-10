CREATE TABLE ortho_study_export_jobs (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  revision_id INTEGER NOT NULL REFERENCES ortho_case_study_revisions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  revision_sha256 TEXT NOT NULL CHECK(revision_sha256 ~ '^[a-f0-9]{64}$'),
  command_id TEXT NOT NULL CHECK(command_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
  command JSONB NOT NULL CHECK(jsonb_typeof(command)='object' AND octet_length(command::text)<=2048),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  format TEXT NOT NULL CHECK(format IN ('text-pptx','illustrated-pptx')),
  render_binding JSONB NOT NULL CHECK(jsonb_typeof(render_binding)='object' AND octet_length(render_binding::text)<=4096),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','ready','failed','cancelled')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  failure_code TEXT CHECK(failure_code IN ('render_failed','render_limit','storage_unavailable','storage_failed','authority_changed','lease_expired','renderer_unavailable')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(ortho_case_id,actor_user_id,command_id),
  CHECK(updated_at>=created_at),
  CHECK((state='running' AND generation>0 AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state<>'running' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK((state='failed')=(failure_code IS NOT NULL)),
  CHECK((state='queued' AND generation=0) OR (state IN ('running','ready','failed') AND generation>0) OR state='cancelled')
);
CREATE INDEX ortho_study_export_jobs_case_revision ON ortho_study_export_jobs(ortho_case_id,revision_id,id DESC);
CREATE TABLE ortho_study_export_artifacts (
  job_id INTEGER PRIMARY KEY REFERENCES ortho_study_export_jobs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  storage_key TEXT NOT NULL CHECK(storage_key ~ '^[a-f0-9]{2}/[a-f0-9]{2}/[a-f0-9]{64}\.pptx$'),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0 AND size_bytes<=25165824),
  page_count INTEGER NOT NULL CHECK(page_count>0 AND page_count<=300),
  manifest JSONB NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=1048576),
  manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(storage_key=substr(sha256,1,2)||'/'||substr(sha256,3,2)||'/'||sha256||'.pptx')
);
CREATE FUNCTION guard_ortho_study_export_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_study_export_jobs) THEN RETURN NULL; END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Export job history cannot be erased' USING ERRCODE='55000'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','generation','lease_token','lease_expires_at','failure_code','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','generation','lease_token','lease_expires_at','failure_code','updated_at'])
    OR NEW.updated_at<OLD.updated_at THEN
    RAISE EXCEPTION 'Export job identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF OLD.state IN ('ready','cancelled') THEN RAISE EXCEPTION 'Export outcome is terminal' USING ERRCODE='55000'; END IF;
  IF NEW.state='running' THEN
    IF NOT (OLD.state IN ('queued','failed') OR (OLD.state='running' AND OLD.lease_expires_at<=clock_timestamp()))
      OR NEW.generation<>OLD.generation+1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
      OR NEW.lease_expires_at<=clock_timestamp() OR NEW.lease_expires_at>clock_timestamp()+INTERVAL '61 seconds' THEN
      RAISE EXCEPTION 'Invalid export lease transition' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.generation<>OLD.generation OR NOT (NEW.state='cancelled' OR (OLD.state='running' AND NEW.state IN ('ready','failed'))) THEN
      RAISE EXCEPTION 'Invalid export outcome transition' USING ERRCODE='23514';
    END IF;
    IF NEW.state='ready' AND OLD.lease_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'Expired export lease cannot publish' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ortho_export_job_mutation BEFORE UPDATE OR DELETE ON ortho_study_export_jobs FOR EACH ROW EXECUTE FUNCTION guard_ortho_study_export_job();
CREATE TRIGGER ortho_export_job_truncate BEFORE TRUNCATE ON ortho_study_export_jobs FOR EACH STATEMENT EXECUTE FUNCTION guard_ortho_study_export_job();
CREATE FUNCTION guard_ortho_study_export_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ortho_study_export_artifacts) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Published export artifacts are immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER ortho_export_artifact_mutation BEFORE UPDATE OR DELETE ON ortho_study_export_artifacts FOR EACH ROW EXECUTE FUNCTION guard_ortho_study_export_artifact();
CREATE TRIGGER ortho_export_artifact_truncate BEFORE TRUNCATE ON ortho_study_export_artifacts FOR EACH STATEMENT EXECUTE FUNCTION guard_ortho_study_export_artifact();
CREATE FUNCTION check_ortho_study_export_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j ortho_study_export_jobs%ROWTYPE; a ortho_study_export_artifacts%ROWTYPE; target_id INTEGER;
BEGIN
  IF TG_TABLE_NAME='ortho_study_export_jobs' THEN target_id:=NEW.id; ELSE target_id:=NEW.job_id; END IF;
  SELECT * INTO j FROM ortho_study_export_jobs WHERE id=target_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing export job' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM ortho_case_study_revisions r WHERE r.id=j.revision_id AND r.patient_id=j.patient_id
    AND r.ortho_case_id=j.ortho_case_id AND r.clinical_case_id=j.clinical_case_id AND r.content_sha256=j.revision_sha256)
    OR NOT EXISTS(SELECT 1 FROM ortho_cases o JOIN clinical_cases c ON c.ortho_case_id=o.id
      WHERE o.id=j.ortho_case_id AND o.patient_id=j.patient_id AND c.id=j.clinical_case_id AND c.patient_id=j.patient_id AND c.specialty='orthodontics')
    OR j.command->>'clientRequestId' IS DISTINCT FROM j.command_id
    OR j.command->'revisionId' IS DISTINCT FROM to_jsonb(j.revision_id)
    OR j.command->>'revisionHash' IS DISTINCT FROM j.revision_sha256
    OR j.command->>'format' IS DISTINCT FROM j.format
    OR j.command->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR j.render_binding->>'language' IS DISTINCT FROM 'ar' OR j.render_binding->>'privacy' IS DISTINCT FROM 'clinical' THEN
    RAISE EXCEPTION 'Export job scope mismatch' USING ERRCODE='23514';
  END IF;
  SELECT * INTO a FROM ortho_study_export_artifacts WHERE job_id=j.id;
  IF (j.state='ready') IS DISTINCT FROM FOUND THEN RAISE EXCEPTION 'Export artifact publication mismatch' USING ERRCODE='23514'; END IF;
  IF j.state='ready' AND (a.manifest->'jobId' IS DISTINCT FROM to_jsonb(j.id)
    OR a.manifest->'revisionId' IS DISTINCT FROM to_jsonb(j.revision_id)
    OR a.manifest->>'revisionHash' IS DISTINCT FROM j.revision_sha256
    OR a.manifest->'renderBinding' IS DISTINCT FROM j.render_binding
    OR a.manifest->>'sha256' IS DISTINCT FROM a.sha256
    OR a.manifest->'sizeBytes' IS DISTINCT FROM to_jsonb(a.size_bytes)
    OR a.manifest->'pageCount' IS DISTINCT FROM to_jsonb(a.page_count)) THEN
    RAISE EXCEPTION 'Export manifest mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ortho_export_job_binding AFTER INSERT OR UPDATE ON ortho_study_export_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_study_export_binding();
CREATE CONSTRAINT TRIGGER ortho_export_artifact_binding AFTER INSERT ON ortho_study_export_artifacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_study_export_binding();
CREATE FUNCTION guard_ortho_study_export_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM ortho_study_export_jobs j
    JOIN ortho_cases o ON o.id=j.ortho_case_id
    JOIN clinical_cases c ON c.id=j.clinical_case_id
    JOIN ortho_case_study_revisions r ON r.id=j.revision_id
    WHERE ((TG_TABLE_NAME='ortho_cases' AND j.ortho_case_id=NEW.id)
      OR (TG_TABLE_NAME='clinical_cases' AND j.clinical_case_id=NEW.id)
      OR (TG_TABLE_NAME='ortho_case_study_revisions' AND j.revision_id=NEW.id))
    AND (o.patient_id<>j.patient_id OR c.patient_id<>j.patient_id OR c.ortho_case_id IS DISTINCT FROM j.ortho_case_id OR c.specialty<>'orthodontics'
      OR r.patient_id<>j.patient_id OR r.ortho_case_id<>j.ortho_case_id OR r.clinical_case_id<>j.clinical_case_id OR r.content_sha256<>j.revision_sha256)) THEN
    RAISE EXCEPTION 'Export scope is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ortho_export_case_scope AFTER UPDATE ON ortho_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_ortho_study_export_scope();
CREATE CONSTRAINT TRIGGER ortho_export_clinical_scope AFTER UPDATE ON clinical_cases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_ortho_study_export_scope();
CREATE CONSTRAINT TRIGGER ortho_export_revision_scope AFTER UPDATE ON ortho_case_study_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_ortho_study_export_scope();

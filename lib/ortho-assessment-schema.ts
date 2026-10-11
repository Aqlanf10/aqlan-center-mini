/** New unpublished0052 source; migration body is identical. */
export const ORTHO_ASSESSMENT_SQL = `-- Newly reauthored unpublished0052. Apply only after exact live registry/object preflight.
-- No clinical facts, cases, approvals, treatment or financial records are backfilled.
CREATE TABLE IF NOT EXISTS ortho_assessment_revisions (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  recorded_patient_id INTEGER NOT NULL CHECK(recorded_patient_id>0),
  ortho_case_id INTEGER NOT NULL REFERENCES ortho_cases(id) ON DELETE RESTRICT,
  clinical_case_id INTEGER NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  schema_version SMALLINT NOT NULL CHECK(schema_version IN (1,2)),
  version INTEGER NOT NULL CHECK(version>0),
  supersedes_revision_id INTEGER,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL CHECK(length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  recording_context TEXT NOT NULL CHECK(recording_context IN ('current','retrospective')),
  command_id TEXT NOT NULL CHECK(command_id ~ '^[A-Za-z0-9_-]{16,80}$'),
  request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  content JSONB NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=1048576),
  CONSTRAINT ortho_assessment_case_version_unique UNIQUE(ortho_case_id,version),
  CONSTRAINT ortho_assessment_case_identity_unique UNIQUE(ortho_case_id,id),
  CONSTRAINT ortho_assessment_command_unique UNIQUE(ortho_case_id,actor_user_id,command_id),
  CONSTRAINT ortho_assessment_successor_unique UNIQUE(supersedes_revision_id),
  CONSTRAINT ortho_assessment_first_revision CHECK((version=1)=(supersedes_revision_id IS NULL)),
  CONSTRAINT ortho_assessment_not_self CHECK(supersedes_revision_id IS NULL OR supersedes_revision_id<>id),
  CONSTRAINT ortho_assessment_same_case_predecessor FOREIGN KEY(ortho_case_id,supersedes_revision_id)
    REFERENCES ortho_assessment_revisions(ortho_case_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS ortho_assessment_patient_case_version_idx ON ortho_assessment_revisions(patient_id,ortho_case_id,version DESC);
CREATE OR REPLACE FUNCTION reject_ortho_assessment_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Canonical patient merge may update current ownership only. Recorded origin
  -- and every clinical/hash/actor/lineage field remain immutable.
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'patient_id')=(to_jsonb(OLD)-'patient_id') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Orthodontic assessment revisions are append-only' USING ERRCODE='55000';
END;
$$;
CREATE OR REPLACE FUNCTION check_ortho_assessment_revision_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_revision ortho_assessment_revisions%ROWTYPE;
  predecessor ortho_assessment_revisions%ROWTYPE;
  current_patient INTEGER;
  bridge_patient INTEGER;
  bridge_ortho INTEGER;
  entry JSONB;
  selection JSONB;
  n INTEGER;
  analysis_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT * INTO current_revision FROM ortho_assessment_revisions WHERE id=NEW.id;
  SELECT patient_id INTO current_patient FROM ortho_cases WHERE id=current_revision.ortho_case_id;
  SELECT patient_id,ortho_case_id INTO bridge_patient,bridge_ortho FROM clinical_cases WHERE id=current_revision.clinical_case_id;
  IF current_patient IS DISTINCT FROM current_revision.patient_id OR bridge_patient IS DISTINCT FROM current_revision.patient_id OR bridge_ortho IS DISTINCT FROM current_revision.ortho_case_id THEN
    RAISE EXCEPTION 'Assessment owner and clinical bridge mismatch' USING ERRCODE='23514';
  END IF;
  IF current_revision.supersedes_revision_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM ortho_assessment_revisions WHERE id=current_revision.supersedes_revision_id AND ortho_case_id=current_revision.ortho_case_id;
    IF NOT FOUND OR predecessor.version+1<>current_revision.version OR predecessor.clinical_case_id<>current_revision.clinical_case_id OR predecessor.schema_version>current_revision.schema_version THEN
      RAISE EXCEPTION 'Assessment lineage mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  -- Unknown existing schema1 rows are preserved. New application admission refuses
  -- them; this trigger does not guess their old clinical content structure.
  IF current_revision.schema_version=2 THEN
    IF current_revision.content->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR current_revision.content->>'verifierVersion' IS DISTINCT FROM 'ortho-assessment-payload-2.1.0'
      OR jsonb_typeof(current_revision.content->'draft') IS DISTINCT FROM 'object'
      OR current_revision.content->'draft'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR jsonb_typeof(current_revision.content->'results') IS DISTINCT FROM 'array'
      OR jsonb_typeof(current_revision.content->'draft'->'analyses') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Assessment payload version mismatch' USING ERRCODE='23514';
    END IF;
    n:=jsonb_array_length(current_revision.content->'results');
    IF n>36 OR n<>jsonb_array_length(current_revision.content->'draft'->'analyses') THEN
      RAISE EXCEPTION 'Assessment result count mismatch' USING ERRCODE='23514';
    END IF;
    IF n>0 THEN FOR i IN 0..n-1 LOOP
      entry:=current_revision.content->'results'->i;
      selection:=current_revision.content->'draft'->'analyses'->i;
      IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR jsonb_typeof(entry->'result') IS DISTINCT FROM 'object'
        OR jsonb_typeof(selection) IS DISTINCT FROM 'object'
        OR jsonb_typeof(selection->'id') IS DISTINCT FROM 'string'
        OR COALESCE(selection->>'id','') !~ '^[A-Za-z0-9_-]{1,80}$'
        OR (selection->>'id')=ANY(analysis_ids)
        OR jsonb_typeof(entry->'analysisId') IS DISTINCT FROM 'string'
        OR entry->>'analysisId' IS DISTINCT FROM selection->>'id' OR selection->>'state' IS DISTINCT FROM 'draft'
        OR COALESCE(entry->>'resultHash','') !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'Assessment result identity mismatch' USING ERRCODE='23514';
      END IF;
      analysis_ids:=array_append(analysis_ids,selection->>'id');
    END LOOP; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_assessment_revisions'::regclass AND tgname='ortho_assessment_revision_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER ortho_assessment_revision_immutable BEFORE UPDATE OR DELETE ON ortho_assessment_revisions FOR EACH ROW EXECUTE FUNCTION reject_ortho_assessment_revision_mutation();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='ortho_assessment_revisions'::regclass AND tgname='ortho_assessment_revision_final' AND NOT tgisinternal) THEN
    CREATE CONSTRAINT TRIGGER ortho_assessment_revision_final AFTER INSERT OR UPDATE ON ortho_assessment_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ortho_assessment_revision_final_state();
  END IF;
END; $$;
`;

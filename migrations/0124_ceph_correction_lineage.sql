-- Additive ancestry for newly created correction drafts only. Old notes are not parsed.
ALTER TABLE ceph_analyses
  ADD COLUMN corrects_analysis_id BIGINT REFERENCES ceph_analyses(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN correction_source JSONB,
  ADD COLUMN correction_source_canonical TEXT,
  ADD COLUMN correction_source_sha256 TEXT,
  ADD CONSTRAINT ceph_correction_origin_complete CHECK (COALESCE(
    (corrects_analysis_id IS NULL AND correction_source IS NULL AND correction_source_canonical IS NULL AND correction_source_sha256 IS NULL)
    OR (corrects_analysis_id IS NOT NULL AND corrects_analysis_id<>id
      AND correction_source IS NOT NULL AND jsonb_typeof(correction_source)='object'
      AND correction_source ?& ARRAY['schemaVersion','parentAnalysisId','recordedPatientId','orthoCaseId','documentId','parentCompletion','sourceSnapshotSha256']
      AND (correction_source-ARRAY['schemaVersion','parentAnalysisId','recordedPatientId','orthoCaseId','documentId','parentCompletion','sourceSnapshotSha256'])='{}'::jsonb
      AND correction_source_canonical IS NOT NULL AND octet_length(correction_source_canonical)<=8192
      AND correction_source_canonical::jsonb=correction_source
      AND correction_source_sha256 IS NOT NULL AND correction_source_sha256 ~ '^[a-f0-9]{64}$'
      AND correction_source_sha256=encode(sha256(convert_to(correction_source_canonical,'UTF8')),'hex')
      AND correction_source->'schemaVersion'='1'::jsonb
      AND jsonb_typeof(correction_source->'parentAnalysisId')='number'
      AND jsonb_typeof(correction_source->'recordedPatientId')='number'
      AND jsonb_typeof(correction_source->'documentId')='number'
      AND (correction_source->'orthoCaseId'='null'::jsonb OR jsonb_typeof(correction_source->'orthoCaseId')='number')
      AND jsonb_typeof(correction_source->'sourceSnapshotSha256')='string'
      AND jsonb_typeof(correction_source->'parentCompletion')='object'
      AND ((correction_source->'parentCompletion'->>'state'='versioned'
        AND (correction_source->'parentCompletion') ?& ARRAY['state','witnessVersion','witnessSha256']
        AND ((correction_source->'parentCompletion')-ARRAY['state','witnessVersion','witnessSha256'])='{}'::jsonb
        AND correction_source->'parentCompletion'->'witnessVersion' IN ('1'::jsonb,'2'::jsonb)
        AND jsonb_typeof(correction_source->'parentCompletion'->'witnessSha256')='string'
        AND correction_source->'parentCompletion'->>'witnessSha256' ~ '^[a-f0-9]{64}$')
       OR correction_source->'parentCompletion'='{"state":"unversioned","reason":"historical_completion_without_witness"}'::jsonb)
      AND (correction_source->>'parentAnalysisId')::bigint=corrects_analysis_id
      AND (correction_source->>'documentId')::bigint=document_id
      AND (correction_source->>'recordedPatientId')::bigint>0
      AND (correction_source->>'orthoCaseId')::integer IS NOT DISTINCT FROM ortho_case_id
      AND correction_source->>'sourceSnapshotSha256' ~ '^[a-f0-9]{64}$'),FALSE));
CREATE INDEX ceph_correction_parent_idx ON ceph_analyses(corrects_analysis_id) WHERE corrects_analysis_id IS NOT NULL;
CREATE FUNCTION guard_ceph_correction_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM ceph_analyses WHERE corrects_analysis_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Cephalometric correction history cannot be erased' USING ERRCODE='55000';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.corrects_analysis_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cephalometric correction history cannot be erased' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.corrects_analysis_id,NEW.correction_source,NEW.correction_source_canonical,NEW.correction_source_sha256)
    IS DISTINCT FROM ROW(OLD.corrects_analysis_id,OLD.correction_source,OLD.correction_source_canonical,OLD.correction_source_sha256) THEN
    RAISE EXCEPTION 'Cephalometric correction origin is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ceph_correction_origin_immutable BEFORE UPDATE OR DELETE ON ceph_analyses
  FOR EACH ROW EXECUTE FUNCTION guard_ceph_correction_lineage();
CREATE TRIGGER ceph_correction_history_no_truncate BEFORE TRUNCATE ON ceph_analyses
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ceph_correction_lineage();
CREATE FUNCTION check_ceph_correction_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child ceph_analyses%ROWTYPE; parent ceph_analyses%ROWTYPE; seal ceph_completion_provenance%ROWTYPE; bad BOOLEAN;
BEGIN
  -- Deferred final state supports fresh restore ordering and atomic legal patient merges.
  FOR child IN SELECT * FROM ceph_analyses WHERE corrects_analysis_id IS NOT NULL
    AND (id=NEW.id OR corrects_analysis_id=NEW.id) ORDER BY id
  LOOP
    SELECT * INTO parent FROM ceph_analyses WHERE id=child.corrects_analysis_id FOR SHARE;
    IF parent.id IS NULL OR parent.status<>'completed' OR parent.patient_id<>child.patient_id
      OR parent.document_id<>child.document_id OR parent.ortho_case_id IS DISTINCT FROM child.ortho_case_id THEN
      RAISE EXCEPTION 'Cephalometric correction source must share patient case and image with a completed parent' USING ERRCODE='23514';
    END IF;
    IF child.correction_source->'parentCompletion'->>'state'='versioned' THEN
      SELECT * INTO seal FROM ceph_completion_provenance WHERE analysis_id=parent.id;
      IF NOT FOUND OR seal.witness_sha256 IS DISTINCT FROM child.correction_source->'parentCompletion'->>'witnessSha256'
        OR seal.schema_version IS DISTINCT FROM (child.correction_source->'parentCompletion'->>'witnessVersion')::integer THEN
        RAISE EXCEPTION 'Cephalometric correction must retain its exact parent witness' USING ERRCODE='23514';
      END IF;
    ELSIF child.correction_source->'parentCompletion'->>'state' IS DISTINCT FROM 'unversioned'
      OR child.correction_source->'parentCompletion'->>'reason' IS DISTINCT FROM 'historical_completion_without_witness'
      OR EXISTS(SELECT 1 FROM ceph_completion_provenance WHERE analysis_id=parent.id) THEN
      RAISE EXCEPTION 'Cephalometric correction parent proof is invalid' USING ERRCODE='23514';
    END IF;
    WITH RECURSIVE ancestry AS (
      SELECT id,corrects_analysis_id,ARRAY[id] AS path,FALSE AS cycle,1 AS depth FROM ceph_analyses WHERE id=child.id
      UNION ALL
      SELECT p.id,p.corrects_analysis_id,a.path||p.id,p.id=ANY(a.path),a.depth+1
        FROM ancestry a JOIN ceph_analyses p ON p.id=a.corrects_analysis_id WHERE NOT a.cycle AND a.depth<65
    ) SELECT COALESCE(bool_or(cycle OR (depth=65 AND corrects_analysis_id IS NOT NULL)),FALSE) INTO bad FROM ancestry;
    IF bad THEN RAISE EXCEPTION 'Cephalometric correction ancestry is cyclic or over budget' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ceph_correction_final_state AFTER INSERT OR UPDATE ON ceph_analyses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ceph_correction_final_state();

// Exact runtime mirror of the additive migration. Do not backfill historical signatures.
export const CEPH_COMPLETION_PROVENANCE_SQL = `-- Additive only: existing completed analyses remain explicitly unversioned.
-- Never reconstruct a historical witness using today's algorithms or references.
CREATE TABLE ceph_completion_provenance (
  analysis_id BIGINT PRIMARY KEY REFERENCES ceph_analyses(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  witness JSONB NOT NULL CHECK(jsonb_typeof(witness)='object' AND octet_length(witness::text)<=2097152),
  witness_sha256 TEXT NOT NULL CHECK(witness_sha256 ~ '^[a-f0-9]{64}$'),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sealed_by TEXT NOT NULL CHECK(length(btrim(sealed_by))>0),
  sealed_at TIMESTAMPTZ NOT NULL
);
CREATE FUNCTION guard_ceph_completion_provenance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Empty fresh restore/reset is safe; existing signed evidence is never erased.
  IF TG_OP='TRUNCATE' AND NOT EXISTS(SELECT 1 FROM ceph_completion_provenance) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Cephalometric completion provenance is immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER ceph_completion_provenance_immutable BEFORE UPDATE OR DELETE ON ceph_completion_provenance
  FOR EACH ROW EXECUTE FUNCTION guard_ceph_completion_provenance_mutation();
CREATE TRIGGER ceph_completion_provenance_no_truncate BEFORE TRUNCATE ON ceph_completion_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ceph_completion_provenance_mutation();
CREATE FUNCTION guard_witnessed_ceph_analysis_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Ownership follows a legal patient merge; the original identity in the witness
  -- remains untouched. All other sealed analysis columns remain immutable.
  IF EXISTS(SELECT 1 FROM ceph_completion_provenance WHERE analysis_id=OLD.id)
    AND (to_jsonb(NEW)-'patient_id') IS DISTINCT FROM (to_jsonb(OLD)-'patient_id') THEN
    RAISE EXCEPTION 'Witnessed cephalometric analysis is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ceph_witnessed_analysis_immutable BEFORE UPDATE ON ceph_analyses
  FOR EACH ROW EXECUTE FUNCTION guard_witnessed_ceph_analysis_mutation();
CREATE FUNCTION check_ceph_completion_provenance_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p ceph_completion_provenance%ROWTYPE; a ceph_analyses%ROWTYPE; target_id BIGINT;
BEGIN
  IF TG_TABLE_NAME='ceph_analyses' THEN target_id := NEW.id;
  ELSE target_id := NEW.analysis_id; END IF;
  -- Serialize against parent updates even if the witness was inserted directly.
  SELECT * INTO a FROM ceph_analyses WHERE id=target_id FOR SHARE;
  SELECT * INTO p FROM ceph_completion_provenance WHERE analysis_id=target_id;
  IF NOT FOUND THEN RETURN NULL; END IF; -- Historical unversioned records are legal.
  IF a.id IS NULL OR a.status<>'completed' OR a.completed_by IS DISTINCT FROM p.sealed_by
    OR a.completed_at IS DISTINCT FROM p.sealed_at THEN
    RAISE EXCEPTION 'Cephalometric provenance must match completed signature' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
-- Deferred checks allow atomic completion and fresh archive restore ordering.
CREATE CONSTRAINT TRIGGER ceph_completion_provenance_final_state AFTER INSERT ON ceph_completion_provenance
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ceph_completion_provenance_final_state();
CREATE CONSTRAINT TRIGGER ceph_analysis_provenance_final_state AFTER INSERT OR UPDATE ON ceph_analyses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ceph_completion_provenance_final_state();
`;

/** Byte-identical runtime mirror of migrations/0137_ceph_completion_provenance.sql (pinned by test).
 * Adapted from #530 migrations 0113/0114. Additive only: existing completions stay "unversioned" and are never
 * back-filled with today's engine or references. */
export const CEPH_COMPLETION_PROVENANCE_SQL = String.raw`-- 0137: sealed provenance for NEW cephalometric completions (additive; no back-fill).
CREATE TABLE IF NOT EXISTS ceph_completion_provenance (
  analysis_id BIGINT PRIMARY KEY REFERENCES ceph_analyses(id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  witness JSONB NOT NULL CHECK (jsonb_typeof(witness) = 'object' AND octet_length(witness::text) <= 2097152),
  witness_sha256 TEXT NOT NULL CHECK (witness_sha256 ~ '^[a-f0-9]{64}$'),
  approved_draft_version TEXT NOT NULL CHECK (approved_draft_version ~ '^[a-f0-9]{64}$'),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sealed_by TEXT NOT NULL CHECK (length(btrim(sealed_by)) > 0),
  sealed_at TIMESTAMPTZ NOT NULL
);
CREATE OR REPLACE FUNCTION guard_ceph_completion_provenance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- An empty table may be truncated by a fresh restore/reset; sealed evidence is never erased or edited.
  IF TG_OP = 'TRUNCATE' AND NOT EXISTS (SELECT 1 FROM ceph_completion_provenance) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'Cephalometric completion provenance is immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS ceph_completion_provenance_immutable ON ceph_completion_provenance;
CREATE TRIGGER ceph_completion_provenance_immutable BEFORE UPDATE OR DELETE ON ceph_completion_provenance
  FOR EACH ROW EXECUTE FUNCTION guard_ceph_completion_provenance_mutation();
DROP TRIGGER IF EXISTS ceph_completion_provenance_no_truncate ON ceph_completion_provenance;
CREATE TRIGGER ceph_completion_provenance_no_truncate BEFORE TRUNCATE ON ceph_completion_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION guard_ceph_completion_provenance_mutation();
CREATE OR REPLACE FUNCTION guard_witnessed_ceph_analysis_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A legal patient merge may move ownership; the recorded identity stays in the witness. Nothing else changes.
  IF EXISTS (SELECT 1 FROM ceph_completion_provenance WHERE analysis_id = OLD.id)
    AND (to_jsonb(NEW) - 'patient_id') IS DISTINCT FROM (to_jsonb(OLD) - 'patient_id') THEN
    RAISE EXCEPTION 'Witnessed cephalometric analysis is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ceph_witnessed_analysis_immutable ON ceph_analyses;
CREATE TRIGGER ceph_witnessed_analysis_immutable BEFORE UPDATE ON ceph_analyses
  FOR EACH ROW EXECUTE FUNCTION guard_witnessed_ceph_analysis_mutation();
CREATE OR REPLACE FUNCTION guard_witnessed_ceph_child_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD.analysis_id; ELSE target := NEW.analysis_id; END IF;
  IF EXISTS (SELECT 1 FROM ceph_completion_provenance WHERE analysis_id = target)
    OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM ceph_completion_provenance WHERE analysis_id = OLD.analysis_id)) THEN
    RAISE EXCEPTION 'Witnessed cephalometric inputs are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ceph_witnessed_landmarks_immutable ON ceph_landmarks;
CREATE TRIGGER ceph_witnessed_landmarks_immutable BEFORE INSERT OR UPDATE OR DELETE ON ceph_landmarks
  FOR EACH ROW EXECUTE FUNCTION guard_witnessed_ceph_child_mutation();
DROP TRIGGER IF EXISTS ceph_witnessed_measurements_immutable ON ceph_measurements;
CREATE TRIGGER ceph_witnessed_measurements_immutable BEFORE INSERT OR UPDATE OR DELETE ON ceph_measurements
  FOR EACH ROW EXECUTE FUNCTION guard_witnessed_ceph_child_mutation();
DROP TRIGGER IF EXISTS ceph_witnessed_diagnoses_immutable ON ceph_diagnoses;
CREATE TRIGGER ceph_witnessed_diagnoses_immutable BEFORE INSERT OR UPDATE OR DELETE ON ceph_diagnoses
  FOR EACH ROW EXECUTE FUNCTION guard_witnessed_ceph_child_mutation();
CREATE OR REPLACE FUNCTION check_ceph_completion_provenance_final_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p ceph_completion_provenance%ROWTYPE; a ceph_analyses%ROWTYPE; target BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'ceph_analyses' THEN target := NEW.id; ELSE target := NEW.analysis_id; END IF;
  SELECT * INTO a FROM ceph_analyses WHERE id = target FOR SHARE;
  SELECT * INTO p FROM ceph_completion_provenance WHERE analysis_id = target;
  IF NOT FOUND THEN RETURN NULL; END IF; -- historical, unversioned completions remain legal
  IF a.id IS NULL OR a.status <> 'completed' OR a.completed_by IS DISTINCT FROM p.sealed_by
    OR a.completed_at IS DISTINCT FROM p.sealed_at THEN
    RAISE EXCEPTION 'Cephalometric provenance must match the completed signature' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS ceph_completion_provenance_final_state ON ceph_completion_provenance;
CREATE CONSTRAINT TRIGGER ceph_completion_provenance_final_state AFTER INSERT ON ceph_completion_provenance
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ceph_completion_provenance_final_state();
DROP TRIGGER IF EXISTS ceph_analysis_provenance_final_state ON ceph_analyses;
CREATE CONSTRAINT TRIGGER ceph_analysis_provenance_final_state AFTER INSERT OR UPDATE ON ceph_analyses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_ceph_completion_provenance_final_state();
`;

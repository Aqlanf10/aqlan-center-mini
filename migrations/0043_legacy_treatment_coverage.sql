-- Immutable complete coverage for newly registered historical agreements.
-- Additive storage only; no old-row backfill, money, consent, sessions or correction workflow.
-- Body must remain byte-for-byte equal to LEGACY_TREATMENT_COVERAGE_SQL after these comments.
CREATE OR REPLACE FUNCTION aqlan_legacy_coverage_site_valid(
  category TEXT, mode TEXT, anchor SMALLINT, teeth SMALLINT[], scope TEXT, surfaces TEXT
) RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    teeth IS NOT NULL
    AND cardinality(teeth) BETWEEN 0 AND 32
    AND teeth = ARRAY(SELECT DISTINCT tooth FROM unnest(teeth) AS tooth ORDER BY tooth)
    AND NOT EXISTS (SELECT 1 FROM unnest(teeth) AS tooth WHERE tooth IS NULL
      OR NOT ((tooth / 10 BETWEEN 1 AND 4 AND tooth % 10 BETWEEN 1 AND 8)
           OR (tooth / 10 BETWEEN 5 AND 8 AND tooth % 10 BETWEEN 1 AND 5)))
    AND CASE
      WHEN category IN ('rct', 'post', 'implant', 'extraction', 'surgery') THEN
        mode = 'per_tooth_episode' AND anchor IS NOT NULL AND teeth = ARRAY[anchor]
        AND scope IS NULL AND surfaces IS NULL
      WHEN category IN ('crown', 'veneer', 'bridge') THEN
        mode = 'multi_tooth_episode' AND anchor IS NOT NULL AND anchor = ANY(teeth)
        AND scope IS NULL AND surfaces IS NULL
      WHEN category IN ('filling', 'sealant') THEN
        mode = 'tooth_surfaces' AND anchor IS NOT NULL AND teeth = ARRAY[anchor] AND scope IS NULL
        AND (surfaces IS NULL OR (length(surfaces) BETWEEN 1 AND 5
          AND surfaces !~ '[^MDOBL]' AND surfaces ~ '^M?D?O?B?L?$'))
      WHEN category = 'ortho' THEN
        mode = 'arch' AND anchor IS NULL AND cardinality(teeth) = 0
        AND scope IN ('upper', 'lower', 'both') AND surfaces IS NULL
      WHEN category = 'cleaning' THEN
        mode = 'region' AND surfaces IS NULL AND (
          (anchor IS NOT NULL AND teeth = ARRAY[anchor] AND scope IS NULL)
          OR (anchor IS NULL AND cardinality(teeth) = 0 AND scope IN ('upper', 'lower', 'full_mouth')))
      WHEN category = 'whitening' THEN
        mode = 'none' AND anchor IS NULL AND cardinality(teeth) = 0
        AND scope = 'full_mouth' AND surfaces IS NULL
      ELSE FALSE
    END, FALSE);
$$ LANGUAGE SQL IMMUTABLE;

CREATE TABLE IF NOT EXISTS legacy_treatment_coverage_snapshots (
  agreement_id          INTEGER PRIMARY KEY REFERENCES legacy_treatment_agreements(id) ON DELETE CASCADE,
  format_version        SMALLINT NOT NULL CHECK (format_version = 1),
  service_id            INTEGER NOT NULL REFERENCES services(id),
  service_category      TEXT NOT NULL,
  anchor_tooth_code     SMALLINT,
  snapshot_mode         TEXT NOT NULL,
  snapshot_tooth_codes  SMALLINT[] NOT NULL,
  snapshot_scope        TEXT,
  snapshot_surfaces     TEXT,
  recorded_by           TEXT NOT NULL CHECK (recorded_by = btrim(recorded_by) AND length(recorded_by) BETWEEN 1 AND 200),
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW() CHECK (isfinite(recorded_at)),
  CONSTRAINT legacy_treatment_coverage_site_check CHECK (
    aqlan_legacy_coverage_site_valid(service_category, snapshot_mode, anchor_tooth_code,
      snapshot_tooth_codes, snapshot_scope, snapshot_surfaces) IS TRUE)
);

CREATE OR REPLACE FUNCTION aqlan_legacy_treatment_coverage_guard() RETURNS trigger AS $$
DECLARE
  agreement_service INTEGER;
  agreement_anchor SMALLINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT service_id, tooth_code INTO agreement_service, agreement_anchor
      FROM legacy_treatment_agreements WHERE id = NEW.agreement_id FOR KEY SHARE;
    IF NOT FOUND OR NEW.service_id IS DISTINCT FROM agreement_service
      OR NEW.anchor_tooth_code IS DISTINCT FROM agreement_anchor THEN
      RAISE EXCEPTION 'legacy coverage must match the immutable agreement service and anchor';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM legacy_treatment_agreements WHERE id = OLD.agreement_id
  ) THEN
    -- Only the existing agreement cascade can remove coverage. Its own guard permits
    -- deletion only when the owning patient has already been deleted.
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'legacy_treatment_coverage_snapshots is append-only: updates and standalone deletes are forbidden';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER legacy_treatment_coverage_guard
  BEFORE INSERT OR UPDATE OR DELETE ON legacy_treatment_coverage_snapshots
  FOR EACH ROW EXECUTE FUNCTION aqlan_legacy_treatment_coverage_guard();

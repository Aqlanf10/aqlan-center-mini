-- (PAT-4) Patient families and guarantor: patient_families (family label, optional guarantor — a patient OR an
-- outside person, never both) + patients.family_id / patients.family_role. Information only: no money column,
-- no allocation across members; each patient's ledger stays exactly as before.
-- Additive only: a new table and two nullable columns; no existing row is touched.
-- Body must remain byte-for-byte equal to PATIENT_FAMILIES_SQL after these comments.
CREATE TABLE IF NOT EXISTS patient_families (
  id                   SERIAL      PRIMARY KEY,
  name                 TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  guarantor_patient_id INTEGER     REFERENCES patients(id) ON DELETE SET NULL,
  guarantor_name       TEXT,
  guarantor_phone      TEXT,
  note                 TEXT,
  created_by           TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT patient_families_one_guarantor_check
    CHECK (guarantor_patient_id IS NULL OR (guarantor_name IS NULL AND guarantor_phone IS NULL)),
  CONSTRAINT patient_families_external_guarantor_check
    CHECK (guarantor_phone IS NULL OR guarantor_name IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS patient_families_guarantor_idx
  ON patient_families (guarantor_patient_id) WHERE guarantor_patient_id IS NOT NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS family_id INTEGER REFERENCES patient_families(id) ON DELETE SET NULL;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS family_role TEXT
  CHECK (family_role IS NULL OR family_role ~ '^[a-z_]{1,20}$');
CREATE INDEX IF NOT EXISTS patients_family_idx ON patients (family_id) WHERE family_id IS NOT NULL;

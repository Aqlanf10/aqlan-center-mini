/**
 * UNREGISTERED PROPOSAL: nothing imports this into ensureSchema or migrations.
 * No SQL has been executed. Root review and isolated PG18 acceptance precede activation.
 * Immutable measurements; only patient ownership may move through canonical patient merge.
 */
export const PERIODONTAL_SQL = `CREATE TABLE IF NOT EXISTS periodontal_records (
  id                  SERIAL PRIMARY KEY,
  patient_id          INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  tooth_code          SMALLINT NOT NULL CHECK (
    (tooth_code / 10 BETWEEN 1 AND 4 AND tooth_code % 10 BETWEEN 1 AND 8)
    OR (tooth_code / 10 BETWEEN 5 AND 8 AND tooth_code % 10 BETWEEN 1 AND 5)
  ),
  prior_record_id     INTEGER,
  request_key         TEXT NOT NULL CHECK (length(request_key) BETWEEN 8 AND 128 AND request_key !~ '[^A-Za-z0-9._:-]'),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64 AND request_fingerprint !~ '[^a-f0-9]'),
  recorded_by         TEXT NOT NULL CHECK (length(btrim(recorded_by)) > 0),
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT periodontal_records_one_request UNIQUE (recorded_by, request_key),
  CONSTRAINT periodontal_record_identity UNIQUE (id, patient_id, tooth_code),
  -- A deferred composite FK protects BOTH sides when ownership changes.
  -- Whole-history patient merge may move rows in any order within its transaction.
  CONSTRAINT periodontal_record_predecessor_owner
    FOREIGN KEY (prior_record_id, patient_id, tooth_code)
    REFERENCES periodontal_records (id, patient_id, tooth_code)
    ON UPDATE NO ACTION ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (prior_record_id IS NULL OR prior_record_id < id)
);
CREATE INDEX IF NOT EXISTS periodontal_records_patient_tooth_idx
  ON periodontal_records (patient_id, tooth_code, id DESC);
CREATE TABLE IF NOT EXISTS periodontal_sites (
  record_id  INTEGER NOT NULL REFERENCES periodontal_records(id) ON DELETE RESTRICT,
  surface    TEXT NOT NULL CHECK (surface IN ('facial', 'lingual')),
  position   TEXT NOT NULL CHECK (position IN ('mesial', 'mid', 'distal')),
  depth_mm   NUMERIC CHECK (depth_mm IS NULL OR (depth_mm >= 0 AND depth_mm < 'Infinity'::numeric)),
  bleeding   BOOLEAN,
  PRIMARY KEY (record_id, surface, position)
);
CREATE OR REPLACE FUNCTION aqlan_periodontal_record_immutable() RETURNS trigger AS $$
BEGIN
  -- Canonical duplicate-patient merge discovers patient FKs and changes only ownership.
  -- Values, original author/time, replay identity and predecessor are never rewritten.
  IF TG_OP = 'UPDATE' AND NEW.patient_id <> OLD.patient_id
     AND (to_jsonb(NEW) - 'patient_id') = (to_jsonb(OLD) - 'patient_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'periodontal records are immutable; append a new measurement';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER periodontal_record_immutable
  BEFORE UPDATE OR DELETE ON periodontal_records
  FOR EACH ROW EXECUTE FUNCTION aqlan_periodontal_record_immutable();
CREATE OR REPLACE FUNCTION aqlan_periodontal_site_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'periodontal sites are immutable; append a new measurement';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER periodontal_site_immutable
  BEFORE UPDATE OR DELETE ON periodontal_sites
  FOR EACH ROW EXECUTE FUNCTION aqlan_periodontal_site_immutable();
CREATE OR REPLACE FUNCTION aqlan_periodontal_record_complete() RETURNS trigger AS $$
BEGIN
  IF (SELECT COUNT(*) FROM periodontal_sites WHERE record_id = NEW.id) <> 6
     OR NOT EXISTS (SELECT 1 FROM periodontal_sites WHERE record_id = NEW.id
                     AND (depth_mm IS NOT NULL OR bleeding IS NOT NULL)) THEN
    RAISE EXCEPTION 'periodontal record requires six explicit sites and a recorded finding';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- PostgreSQL constraint triggers lack CREATE OR REPLACE; install once without dropping a guard.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'periodontal_record_complete'
                 AND tgrelid = 'periodontal_records'::regclass) THEN
    CREATE CONSTRAINT TRIGGER periodontal_record_complete
      AFTER INSERT ON periodontal_records DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION aqlan_periodontal_record_complete();
  END IF;
END; $$;`;

/** Byte-identical to migrations/0041_periodontics.sql. No money or parallel visit engine. */
export const PERIODONTICS_SQL = `CREATE TABLE IF NOT EXISTS perio_exams (
  id SERIAL PRIMARY KEY,
  visit_id INTEGER NOT NULL UNIQUE REFERENCES visits(id) ON DELETE RESTRICT,
  case_id INTEGER REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  doctor_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  recorded_by TEXT NOT NULL CHECK (length(btrim(recorded_by)) > 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT,
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS perio_exams_case_idx ON perio_exams(case_id);
CREATE TABLE IF NOT EXISTS perio_site_observations (
  id SERIAL PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES perio_exams(id) ON DELETE RESTRICT,
  tooth_code SMALLINT NOT NULL CHECK (
    (tooth_code / 10 BETWEEN 1 AND 4 AND tooth_code % 10 BETWEEN 1 AND 8)
    OR (tooth_code / 10 BETWEEN 5 AND 8 AND tooth_code % 10 BETWEEN 1 AND 5)
  ),
  site TEXT NOT NULL CHECK (site IN ('MB', 'B', 'DB', 'ML', 'L', 'DL')),
  probing_depth_mm NUMERIC CHECK (probing_depth_mm IS NULL OR (
    probing_depth_mm >= 0 AND probing_depth_mm <= 99.99 AND scale(probing_depth_mm) <= 2
  )),
  bleeding_on_probing BOOLEAN,
  CONSTRAINT perio_site_observations_one_site UNIQUE (exam_id, tooth_code, site)
);
CREATE TABLE IF NOT EXISTS perio_addenda (
  id SERIAL PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES perio_exams(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL CHECK (request_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4000),
  author TEXT NOT NULL CHECK (length(btrim(author)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT perio_addenda_one_request UNIQUE (exam_id, request_key)
);
CREATE OR REPLACE FUNCTION aqlan_perio_exam_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_patient INTEGER; parent_signed TIMESTAMPTZ; parent_case INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'periodontal clinical history cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.visit_id IS DISTINCT FROM OLD.visit_id
    OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at) THEN
    RAISE EXCEPTION 'periodontal record identity is immutable';
  END IF;
  SELECT patient_id, signed_at, case_id INTO parent_patient, parent_signed, parent_case FROM visits WHERE id = NEW.visit_id FOR UPDATE;
  IF NOT FOUND OR parent_patient IS NULL THEN RAISE EXCEPTION 'periodontal exam requires an existing patient visit'; END IF;
  IF parent_signed IS NOT NULL THEN RAISE EXCEPTION 'signed periodontal record is immutable'; END IF;
  IF parent_case IS NOT NULL AND NEW.case_id IS DISTINCT FROM parent_case THEN
    RAISE EXCEPTION 'periodontal exam conflicts with existing visit case';
  END IF;
  PERFORM 1 FROM parties WHERE id = NEW.doctor_id AND kind = 'doctor' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'periodontal exam requires actual treating doctor'; END IF;
  IF NEW.case_id IS NOT NULL THEN
    PERFORM 1 FROM clinical_cases WHERE id = NEW.case_id AND patient_id = parent_patient AND specialty = 'periodontics' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'periodontal case must belong to the same patient and specialty'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER perio_exams_guard BEFORE INSERT OR UPDATE OR DELETE ON perio_exams
  FOR EACH ROW EXECUTE FUNCTION aqlan_perio_exam_guard();
CREATE OR REPLACE FUNCTION aqlan_perio_site_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_signed TIMESTAMPTZ; target_exam INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.exam_id IS DISTINCT FROM OLD.exam_id
    OR NEW.tooth_code IS DISTINCT FROM OLD.tooth_code OR NEW.site IS DISTINCT FROM OLD.site) THEN
    RAISE EXCEPTION 'periodontal site identity is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN target_exam := OLD.exam_id; ELSE target_exam := NEW.exam_id; END IF;
  SELECT v.signed_at INTO parent_signed FROM visits v JOIN perio_exams e ON e.visit_id = v.id
    WHERE e.id = target_exam FOR UPDATE OF v;
  IF NOT FOUND THEN RAISE EXCEPTION 'periodontal exam does not exist'; END IF;
  IF parent_signed IS NOT NULL THEN RAISE EXCEPTION 'signed periodontal record is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER perio_sites_guard BEFORE INSERT OR UPDATE OR DELETE ON perio_site_observations
  FOR EACH ROW EXECUTE FUNCTION aqlan_perio_site_guard();
CREATE OR REPLACE FUNCTION aqlan_perio_addendum_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_signed TIMESTAMPTZ;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'periodontal addenda are append-only'; END IF;
  SELECT v.signed_at INTO parent_signed FROM visits v JOIN perio_exams e ON e.visit_id = v.id
    WHERE e.id = NEW.exam_id FOR UPDATE OF v;
  IF NOT FOUND OR parent_signed IS NULL THEN RAISE EXCEPTION 'periodontal addendum requires a signed exam'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER perio_addenda_guard BEFORE INSERT OR UPDATE OR DELETE ON perio_addenda
  FOR EACH ROW EXECUTE FUNCTION aqlan_perio_addendum_guard();
CREATE OR REPLACE FUNCTION aqlan_perio_signature_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE exam_case INTEGER;
BEGIN
  IF NEW.case_id IS DISTINCT FROM OLD.case_id THEN
    SELECT case_id INTO exam_case FROM perio_exams WHERE visit_id = OLD.id;
    IF FOUND AND (OLD.signed_at IS NOT NULL OR (NEW.case_id IS NOT NULL AND NEW.case_id IS DISTINCT FROM exam_case)) THEN
      RAISE EXCEPTION 'visit case conflicts with existing periodontal exam';
    END IF;
  END IF;
  IF OLD.signed_at IS NOT NULL AND (NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.signed_by IS DISTINCT FROM OLD.signed_by)
    AND EXISTS (SELECT 1 FROM perio_exams WHERE visit_id = OLD.id) THEN
    RAISE EXCEPTION 'signed periodontal visit signature is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER perio_visit_signature_guard BEFORE UPDATE ON visits
  FOR EACH ROW EXECUTE FUNCTION aqlan_perio_signature_guard();
`;

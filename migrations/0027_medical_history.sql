-- (PAT-2) Structured medical history (append-only versions) and vital signs.
-- Body must remain byte-for-byte equal to MEDICAL_HISTORY_SQL after these comments.
CREATE TABLE IF NOT EXISTS patient_medical_history (
  id                SERIAL      PRIMARY KEY,
  patient_id        INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  answers           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  allergies         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  medications       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  asa_class         TEXT        CHECK (asa_class IS NULL OR asa_class IN ('I', 'II', 'III', 'IV', 'V')),
  blood_group       TEXT        CHECK (blood_group IS NULL OR blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  notes             TEXT,
  patient_confirmed BOOLEAN     NOT NULL DEFAULT FALSE,
  recorded_by       TEXT        NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS patient_medical_history_patient_idx ON patient_medical_history (patient_id, id DESC);

CREATE TABLE IF NOT EXISTS patient_vitals (
  id           SERIAL       PRIMARY KEY,
  patient_id   INTEGER      NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  visit_id     INTEGER      REFERENCES visits(id) ON DELETE SET NULL,
  bp_systolic  SMALLINT     CHECK (bp_systolic IS NULL OR bp_systolic BETWEEN 50 AND 300),
  bp_diastolic SMALLINT     CHECK (bp_diastolic IS NULL OR bp_diastolic BETWEEN 30 AND 200),
  pulse        SMALLINT     CHECK (pulse IS NULL OR pulse BETWEEN 20 AND 250),
  temperature  NUMERIC(4,1) CHECK (temperature IS NULL OR temperature BETWEEN 30 AND 45),
  spo2         SMALLINT     CHECK (spo2 IS NULL OR spo2 BETWEEN 50 AND 100),
  glucose      SMALLINT     CHECK (glucose IS NULL OR glucose BETWEEN 20 AND 800),
  weight_kg    NUMERIC(5,1) CHECK (weight_kg IS NULL OR weight_kg BETWEEN 1 AND 400),
  recorded_by  TEXT         NOT NULL,
  recorded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS patient_vitals_patient_idx ON patient_vitals (patient_id, id DESC);

CREATE OR REPLACE FUNCTION aqlan_medical_history_append_only() RETURNS trigger AS $$
BEGIN
  -- حذف المريض نفسه (التتالي) يُسقط تاريخه معه؛ وما عداه لا يُمسّ.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM patients WHERE id = OLD.patient_id) THEN
    RETURN OLD;
  END IF;
  -- دمج الملف المكرر ينقل السجل إلى الملف الأصلي، وحذف زيارةٍ يفكّ ربط قراءاتها بها:
  -- تغيير المريض أو تفريغ الزيارة وحدهما مسموح — لا حقلٌ سريريٌّ غيرهما.
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'patient_id' - 'visit_id') = (to_jsonb(OLD) - 'patient_id' - 'visit_id')
     AND ((to_jsonb(NEW) -> 'visit_id') = (to_jsonb(OLD) -> 'visit_id') OR to_jsonb(NEW) ->> 'visit_id' IS NULL) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'التاريخ الطبي والعلامات الحيوية سجلٌّ لا يُعدَّل ولا يُحذف — التصحيح نسخةٌ جديدة.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS patient_medical_history_append_only ON patient_medical_history;
CREATE TRIGGER patient_medical_history_append_only BEFORE UPDATE OR DELETE ON patient_medical_history
  FOR EACH ROW EXECUTE FUNCTION aqlan_medical_history_append_only();
DROP TRIGGER IF EXISTS patient_vitals_append_only ON patient_vitals;
CREATE TRIGGER patient_vitals_append_only BEFORE UPDATE OR DELETE ON patient_vitals
  FOR EACH ROW EXECUTE FUNCTION aqlan_medical_history_append_only();

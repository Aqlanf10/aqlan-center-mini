/**
 * (ENDO-1) سير العمل السريري لعلاج العصب — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0040_endodontics.sql` حرفيًّا.
 * إضافيٌّ خالص: أربعة جداول جديدة، لا يُمسّ صفٌّ ولا عمودٌ قائم، ولا مال هنا (الفوترة تبقى على
 * `visit_procedures` وبنود الخطة).
 *
 * - `endo_treatments`: نوبة علاجٍ واحدة لكل (مريض، سن) مرتبطة بحالةٍ تخصصية؛ فهرسٌ فريدٌ جزئيّ يمنع
 *   نوبتين جاريتين على السن نفسه. اعتمادية التاج/الترميم تُسجَّل هنا وتُقيَّم بآلية اعتماديات بنود الخطة.
 * - `endo_visits`: سجلٌّ مهيكلٌ واحد لكل (نوبة، زيارة سريرية): التقييم، بيانات الجلسة، التنبؤ، الخطوة التالية.
 *   التاريخ يعيش هنا فلا يُكتب فوق موقَّع. المفردات تتحقق منها `lib/endodontics.ts`.
 * - `endo_canal_records`: سجلٌّ لكل قناة في الزيارة: الطول العامل ونقطة المرجع وطريقة القياس والتحضير والحشو.
 * - `endo_addenda`: ملاحق إلحاقية على زيارةٍ موقَّعة — تُضاف ولا تمحو.
 */
export const ENDODONTICS_SQL = `CREATE TABLE IF NOT EXISTS endo_treatments (
  id                 SERIAL      PRIMARY KEY,
  patient_id         INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  case_id            INTEGER     NOT NULL REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  tooth_code         SMALLINT    NOT NULL CHECK (
    (tooth_code / 10 BETWEEN 1 AND 4 AND tooth_code % 10 BETWEEN 1 AND 8)
    OR (tooth_code / 10 BETWEEN 5 AND 8 AND tooth_code % 10 BETWEEN 1 AND 5)
  ),
  kind               TEXT        NOT NULL DEFAULT 'initial' CHECK (kind IN ('initial', 'retreatment')),
  status             TEXT        NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  completed_at       TIMESTAMPTZ,
  outcome            TEXT,
  restorative_status TEXT        NOT NULL DEFAULT 'none' CHECK (restorative_status IN ('none', 'temporary', 'permanent')),
  crown_required     BOOLEAN,
  crown_plan_item_id INTEGER     REFERENCES plan_items(id) ON DELETE SET NULL,
  version            INTEGER     NOT NULL DEFAULT 1,
  created_by         TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'in_progress') = (completed_at IS NULL)),
  CHECK (status <> 'abandoned' OR length(btrim(coalesce(outcome, ''))) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS endo_treatments_one_active_tooth_idx
  ON endo_treatments (patient_id, tooth_code) WHERE status = 'in_progress';
CREATE INDEX IF NOT EXISTS endo_treatments_patient_idx ON endo_treatments (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS endo_treatments_case_idx ON endo_treatments (case_id);
CREATE TABLE IF NOT EXISTS endo_visits (
  id                    SERIAL      PRIMARY KEY,
  treatment_id          INTEGER     NOT NULL REFERENCES endo_treatments(id) ON DELETE RESTRICT,
  visit_id              INTEGER     NOT NULL REFERENCES visits(id) ON DELETE RESTRICT,
  doctor_id             INTEGER     REFERENCES parties(id) ON DELETE RESTRICT,
  stage                 TEXT        NOT NULL DEFAULT 'assessment',
  chief_complaint       TEXT,
  symptoms              TEXT,
  pulpal_diagnosis      TEXT,
  apical_diagnosis      TEXT,
  vitality_cold         TEXT,
  vitality_heat         TEXT,
  vitality_ept          TEXT,
  percussion            TEXT,
  palpation             TEXT,
  mobility_grade        SMALLINT    CHECK (mobility_grade IS NULL OR mobility_grade BETWEEN 0 AND 3),
  perio_findings        TEXT,
  previous_treatment    TEXT,
  radiographic_findings TEXT,
  canals_found          SMALLINT    CHECK (canals_found IS NULL OR canals_found BETWEEN 0 AND 8),
  instrumentation       TEXT,
  irrigation            TEXT,
  medicament            TEXT,
  obturation_technique  TEXT,
  obturation_material   TEXT,
  restoration_after     TEXT,
  complications         TEXT,
  prognosis             TEXT,
  next_step             TEXT,
  next_visit_weeks      SMALLINT    CHECK (next_visit_weeks IS NULL OR next_visit_weeks BETWEEN 0 AND 52),
  note                  TEXT,
  version               INTEGER     NOT NULL DEFAULT 1,
  recorded_by           TEXT        NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by            TEXT,
  updated_at            TIMESTAMPTZ,
  CONSTRAINT endo_visits_one_per_visit UNIQUE (treatment_id, visit_id)
);
CREATE INDEX IF NOT EXISTS endo_visits_visit_idx ON endo_visits (visit_id);
CREATE INDEX IF NOT EXISTS endo_visits_treatment_idx ON endo_visits (treatment_id, id);
CREATE TABLE IF NOT EXISTS endo_canal_records (
  id                 SERIAL      PRIMARY KEY,
  endo_visit_id      INTEGER     NOT NULL REFERENCES endo_visits(id) ON DELETE RESTRICT,
  canal_label        TEXT        NOT NULL CHECK (canal_label ~ '^[A-Za-z0-9+-]{1,12}$'),
  working_length_mm  NUMERIC(4,1) CHECK (working_length_mm IS NULL OR (working_length_mm > 0 AND working_length_mm <= 40)),
  reference_point    TEXT,
  measurement_method TEXT,
  master_apical_size SMALLINT    CHECK (master_apical_size IS NULL OR master_apical_size BETWEEN 6 AND 200),
  taper_percent      SMALLINT    CHECK (taper_percent IS NULL OR taper_percent BETWEEN 2 AND 12),
  instrumentation    TEXT,
  obturated          BOOLEAN     NOT NULL DEFAULT FALSE,
  note               TEXT,
  CONSTRAINT endo_canal_records_one_per_canal UNIQUE (endo_visit_id, canal_label)
);
CREATE TABLE IF NOT EXISTS endo_addenda (
  id            SERIAL      PRIMARY KEY,
  endo_visit_id INTEGER     NOT NULL REFERENCES endo_visits(id) ON DELETE RESTRICT,
  request_key   TEXT        NOT NULL CHECK (request_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  body          TEXT        NOT NULL CHECK (length(btrim(body)) > 0),
  author        TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT endo_addenda_one_per_request UNIQUE (endo_visit_id, request_key)
);
CREATE INDEX IF NOT EXISTS endo_addenda_visit_idx ON endo_addenda (endo_visit_id, id);
CREATE OR REPLACE FUNCTION aqlan_endo_addenda_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'endo_addenda is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER endo_addenda_append_only
  BEFORE UPDATE OR DELETE ON endo_addenda
  FOR EACH ROW EXECUTE FUNCTION aqlan_endo_addenda_append_only();
`;

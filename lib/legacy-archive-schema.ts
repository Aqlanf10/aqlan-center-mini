/**
 * (P1-5ج) أرشيف النظام القديم — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0024_legacy_archive.sql` حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * قرار المالك: «كل شيء يدخل كما في النظام القديم». المعالجات والدفعات القديمة تُحفظ هنا
 * **للقراءة** في ملف المريض — بتاريخها وطبيبها وخدمتها وسعرها وعملتها وسعر صرفها
 * وصندوقها — ولا تدخل الصندوق ولا الدفاتر ولا التقارير اليومية (مالٌ قُبض قبل سنتين
 * لا يُحسب في صندوق اليوم). وما بقي منها يدخل الحساب رصيدًا افتتاحيًّا بعملته.
 *
 * رقم المعالجة ورقم الجلسة القديمان فريدان: الملف نفسه لا يُستورد مرتين.
 */
export const LEGACY_ARCHIVE_SQL = `CREATE TABLE IF NOT EXISTS legacy_treatments (
  id              SERIAL      PRIMARY KEY,
  patient_id      INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  legacy_number   INTEGER     NOT NULL UNIQUE,
  treated_on      DATE,
  doctor_name     TEXT,
  service         TEXT,
  currency        TEXT        NOT NULL CHECK (currency IN ('YER', 'SAR', 'USD')),
  price_minor     BIGINT      NOT NULL CHECK (price_minor >= 0),
  rate            NUMERIC,
  paid_minor      BIGINT      NOT NULL CHECK (paid_minor >= 0),
  remaining_minor BIGINT      NOT NULL CHECK (remaining_minor >= 0),
  imported_by     TEXT        NOT NULL,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS legacy_treatments_patient_idx ON legacy_treatments (patient_id);
CREATE TABLE IF NOT EXISTS legacy_payments (
  id                  SERIAL      PRIMARY KEY,
  patient_id          INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  legacy_treatment_id INTEGER     REFERENCES legacy_treatments(id) ON DELETE RESTRICT,
  legacy_number       INTEGER     NOT NULL UNIQUE,
  paid_on             DATE,
  currency            TEXT        NOT NULL CHECK (currency IN ('YER', 'SAR', 'USD')),
  amount_minor        BIGINT      NOT NULL CHECK (amount_minor >= 0),
  rate                NUMERIC,
  method              TEXT,
  cash_box            TEXT,
  service             TEXT,
  doctor_name         TEXT,
  imported_by         TEXT        NOT NULL,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS legacy_payments_patient_idx ON legacy_payments (patient_id);`;

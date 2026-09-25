/**
 * (P3-8) الإحالات الصادرة — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0021_patient_referrals.sql` حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * الإحالة وثيقةٌ سريرية: خطابٌ باسم الطبيب يحمله المريض إلى جرّاح أو أخصائي، ثم
 * يعود بنتيجته. السجل لا يُحذف (RESTRICT على المريض)، ويُغلق بنتيجةٍ أو بإلغاءٍ
 * مسبَّب — والقيود هنا في القاعدة لا في الشاشة وحدها. واسم الطبيب لقطةٌ وقت
 * الإصدار (doctor_name): إعادة طباعة خطابٍ قديم تُخرجه كما صدر وإن تغيّر اسم الجهة.
 */
export const PATIENT_REFERRALS_SQL = `CREATE TABLE IF NOT EXISTS patient_referrals (
  id              SERIAL      PRIMARY KEY,
  patient_id      INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  to_name         TEXT        NOT NULL CHECK (length(btrim(to_name)) > 0),
  to_specialty    TEXT        NOT NULL,
  reason          TEXT        NOT NULL CHECK (length(btrim(reason)) > 0),
  teeth           TEXT,
  urgency         TEXT        NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine', 'soon', 'urgent')),
  status          TEXT        NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'completed', 'cancelled')),
  outcome_note    TEXT,
  doctor_party_id INTEGER     REFERENCES parties(id) ON DELETE RESTRICT,
  doctor_name     TEXT,
  created_by      TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by       TEXT,
  closed_at       TIMESTAMPTZ,
  CHECK ((status = 'sent') = (closed_at IS NULL)),
  CHECK (status <> 'cancelled' OR length(btrim(coalesce(outcome_note, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS patient_referrals_patient_idx ON patient_referrals (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS patient_referrals_open_idx ON patient_referrals (created_at) WHERE status = 'sent';`;

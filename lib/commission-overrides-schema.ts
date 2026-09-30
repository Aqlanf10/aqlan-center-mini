/**
 * (COMM-DETAIL-1 · F-11) النسبة الخاصة بالحالة — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0035_commission_case_overrides.sql`
 * حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا. إضافيٌّ خالص: جدولٌ جديد لا يمسّ صفًّا قائمًا.
 *
 * «٢٥٪ لحالة محمد أحمد لدى د. يوسف»: قاعدةٌ لكل (طبيب، حالة) أو (طبيب، خطة) — ليست سياسة الطبيب
 * ولا حقلًا في الخطة. والسجل **إلحاقيّ**: التغيير أو الإلغاء صفٌّ جديد (`set` أو `void`) يشير إلى
 * ما يَخلُفه (`supersedes_id`)، ولا صفَّ يُعدَّل أو يُحذف (حارس قاعدة). المحلِّل وقت الحدث: أحدث
 * صفٍّ سريانه ≤ اللحظة؛ «الإلغاء» يُسقط إلى الخدمة ثم التخصص ثم الافتراضي.
 */
export const COMMISSION_CASE_OVERRIDES_SQL = `CREATE TABLE IF NOT EXISTS commission_case_overrides (
  id             SERIAL       PRIMARY KEY,
  doctor_id      INTEGER      NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  case_id        INTEGER      REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  plan_id        INTEGER      REFERENCES treatment_plans(id) ON DELETE RESTRICT,
  percent        NUMERIC(5,2) CHECK (percent IS NULL OR (percent >= 0 AND percent <= 100)),
  reason         TEXT         NOT NULL CHECK (length(btrim(reason)) > 0),
  effective_from TIMESTAMPTZ  NOT NULL,
  supersedes_id  INTEGER      REFERENCES commission_case_overrides(id) ON DELETE RESTRICT,
  action         TEXT         NOT NULL DEFAULT 'set' CHECK (action IN ('set', 'void')),
  created_by     TEXT         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK ((case_id IS NULL) <> (plan_id IS NULL)),
  CHECK ((action = 'set') = (percent IS NOT NULL)),
  CHECK (action = 'set' OR supersedes_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS commission_case_overrides_supersedes_uniq
  ON commission_case_overrides (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commission_case_overrides_case_root_uniq
  ON commission_case_overrides (doctor_id, case_id) WHERE supersedes_id IS NULL AND case_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commission_case_overrides_plan_root_uniq
  ON commission_case_overrides (doctor_id, plan_id) WHERE supersedes_id IS NULL AND plan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commission_case_overrides_doctor_idx
  ON commission_case_overrides (doctor_id, effective_from);
CREATE OR REPLACE FUNCTION aqlan_commission_case_overrides_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'النسبة الخاصة بالحالة لا تُعدَّل ولا تُحذف — تُلغى أو تُستبدل بصفٍّ جديد مسبَّب.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS commission_case_overrides_append_only ON commission_case_overrides;
CREATE TRIGGER commission_case_overrides_append_only BEFORE UPDATE OR DELETE ON commission_case_overrides
  FOR EACH ROW EXECUTE FUNCTION aqlan_commission_case_overrides_append_only();`;

/**
 * (P0-1) مخطط سجل عمولات الأطباء — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` (قواعد التشغيل الحالية) وهو جسد الهجرة
 * `migrations/0012_doctor_commission_history.sql` حرفيًّا — والاختبار
 * `__tests__/commission-history-schema.test.ts` يُسقط البناء إن افترقا، فلا تنشأ
 * فروقٌ جديدة بين المسارين (أجساد الدوال تُقارَن حرفيًّا في توصيف ملكية المخطط).
 */
export const DOCTOR_COMMISSION_HISTORY_SQL = `CREATE TABLE IF NOT EXISTS doctor_commission_history (
  id             SERIAL PRIMARY KEY,
  party_id       INTEGER      NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  percent        NUMERIC(5,2) NOT NULL CHECK (percent >= 0 AND percent <= 100),
  config         JSONB        CHECK (config IS NULL OR jsonb_typeof(config) = 'object'),
  effective_from TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  source         TEXT         NOT NULL CHECK (source IN ('baseline', 'party', 'advanced')),
  reason         TEXT,
  recorded_by    TEXT,
  recorded_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS doctor_commission_history_lookup_idx
  ON doctor_commission_history (party_id, effective_from, id);

CREATE OR REPLACE FUNCTION aqlan_commission_history_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'doctor_commission_history سجل تاريخي (append-only): التغيير يُسجَّل بصفٍّ جديد بسريانٍ جديد — لا تعديل ولا حذف.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS doctor_commission_history_no_update ON doctor_commission_history;
CREATE TRIGGER doctor_commission_history_no_update BEFORE UPDATE ON doctor_commission_history
  FOR EACH ROW EXECUTE FUNCTION aqlan_commission_history_append_only_guard();
DROP TRIGGER IF EXISTS doctor_commission_history_no_delete ON doctor_commission_history;
CREATE TRIGGER doctor_commission_history_no_delete BEFORE DELETE ON doctor_commission_history
  FOR EACH ROW EXECUTE FUNCTION aqlan_commission_history_append_only_guard();

-- نسبة الجهة بين 0 و100 — NOT VALID: تُفرض على كل كتابة جديدة ولا تُفشل الهجرة
-- بسبب صفٍّ قديم (المسار البرمجي يرفض خارج المدى منذ البداية).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parties_commission_percent_range') THEN
    ALTER TABLE parties ADD CONSTRAINT parties_commission_percent_range
      CHECK (commission_percent >= 0 AND commission_percent <= 100) NOT VALID;
  END IF;
END $$;

DO $$
DECLARE
  doctor RECORD;
  advanced JSONB;
BEGIN
  FOR doctor IN
    SELECT p.id, p.commission_percent
      FROM parties p
     WHERE p.kind = 'doctor'
       AND NOT EXISTS (SELECT 1 FROM doctor_commission_history h WHERE h.party_id = p.id)
     ORDER BY p.id
  LOOP
    advanced := NULL;
    BEGIN
      SELECT u.commission_config::jsonb INTO advanced
        FROM users u
       WHERE u.party_id = doctor.id
         AND u.commission_config IS NOT NULL
         AND btrim(u.commission_config) NOT IN ('', 'null')
       ORDER BY u.id DESC
       LIMIT 1;
    EXCEPTION WHEN others THEN
      advanced := NULL;
    END;
    IF advanced IS NOT NULL AND jsonb_typeof(advanced) <> 'object' THEN
      advanced := NULL;
    END IF;
    INSERT INTO doctor_commission_history (party_id, percent, config, effective_from, source, reason, recorded_by)
    VALUES (doctor.id, LEAST(100, GREATEST(0, doctor.commission_percent)), advanced,
            TIMESTAMPTZ '1970-01-01 00:00:00+00', 'baseline',
            'القيمة المسجّلة لحظة بدء سجل العمولات — تسري على كل ما قبله', 'migration-0012');
  END LOOP;
END $$;
`;

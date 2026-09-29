/**
 * (TD-REG-028) عملة سطر القيد اليدوي — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0031_journal_line_currency.sql`
 * حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا. إضافيٌّ خالص: لا حذف ولا إعادة كتابة.
 *
 * - كل سطر قيدٍ يدوي يحمل عملته، والمبلغ بوحداتها الصغرى هي. والأسطر التاريخية (قبل هذا العمود)
 *   تأخذ `YER` افتراضًا — وهو **وحدتها الفعلية**: أُدخلت كلها عبر `parseAmount(…, YER)` في دفترٍ
 *   كانت وحدته الريال اليمني، وتحقّق توازنها بها. لا سعر ولا تحويل ولا إعادة كتابة.
 * - القيد اليدوي إلحاقيّ: لا يُعدَّل ولا يُحذف صامتًا — الخطأ يُعكَس بقيدٍ مسبَّب يبقى أثره.
 */
export const JOURNAL_CURRENCY_SQL = `ALTER TABLE journal_manual_lines ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'YER';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_manual_lines_currency_check') THEN
    ALTER TABLE journal_manual_lines
      ADD CONSTRAINT journal_manual_lines_currency_check CHECK (currency IN ('YER', 'SAR', 'USD'));
  END IF;
END $$;
CREATE OR REPLACE FUNCTION aqlan_journal_manual_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'القيد اليدوي لا يُعدَّل ولا يُحذف — يُعكَس بقيدٍ مسبَّب.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS journal_manual_append_only ON journal_manual;
CREATE TRIGGER journal_manual_append_only BEFORE UPDATE OR DELETE ON journal_manual
  FOR EACH ROW EXECUTE FUNCTION aqlan_journal_manual_append_only();
DROP TRIGGER IF EXISTS journal_manual_lines_append_only ON journal_manual_lines;
CREATE TRIGGER journal_manual_lines_append_only BEFORE UPDATE OR DELETE ON journal_manual_lines
  FOR EACH ROW EXECUTE FUNCTION aqlan_journal_manual_append_only();
`;

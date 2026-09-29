-- (TD-REG-028) Journal line currency: every manual journal line carries its currency; historical lines
-- default to YER, the unit they were entered and validated in. Manual journals become append-only.
-- Additive only. Body must remain byte-for-byte equal to JOURNAL_CURRENCY_SQL after these comments.
ALTER TABLE journal_manual_lines ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'YER';
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

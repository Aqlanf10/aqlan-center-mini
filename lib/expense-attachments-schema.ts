/**
 * (P3-6) مرفقات سند الصرف — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0020_expense_attachments.sql` حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * صورة إيصال المورّد أو فاتورته مع سند الصرف: الورقة التي يُطلب إبرازها حين يُراجَع
 * مصروف. الملفّ يُخزَّن بعنوان محتواه (sha256) كسائر المستندات، والسجل append-only:
 * المرفق شاهدٌ مالي لا يُمحى ولا يُبدَّل.
 */
export const EXPENSE_ATTACHMENTS_SQL = `CREATE TABLE IF NOT EXISTS expense_attachments (
  id          SERIAL      PRIMARY KEY,
  expense_id  INTEGER     NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  title       TEXT        NOT NULL,
  mime_type   TEXT        NOT NULL,
  size_bytes  BIGINT      NOT NULL CHECK (size_bytes > 0),
  sha256      TEXT        NOT NULL,
  storage_key TEXT        NOT NULL,
  uploaded_by TEXT        NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS expense_attachments_expense_idx ON expense_attachments (expense_id, id);

CREATE OR REPLACE FUNCTION aqlan_expense_attachments_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'expense_attachments is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS expense_attachments_append_only ON expense_attachments;
CREATE TRIGGER expense_attachments_append_only
  BEFORE UPDATE OR DELETE ON expense_attachments
  FOR EACH ROW EXECUTE FUNCTION aqlan_expense_attachments_append_only();`;

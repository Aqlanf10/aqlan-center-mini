-- (P3-6) Receipt/bill attachments on expense vouchers (append-only).
-- Body must remain byte-for-byte equal to EXPENSE_ATTACHMENTS_SQL after these comments.
CREATE TABLE IF NOT EXISTS expense_attachments (
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
  FOR EACH ROW EXECUTE FUNCTION aqlan_expense_attachments_append_only();

-- (FIN-DISC, owner decision: option 2) An admin discount on an issued invoice is allocated exactly across the invoice's
-- lines, one row per line per decision, at the decision time. The commission base of a line is its value after these rows;
-- collections before a decision keep their commission. Additive only: one new table, its index and an append-only guard.
-- Body must remain byte-for-byte equal to INVOICE_ADMIN_DISCOUNT_SQL after these comments.
CREATE TABLE IF NOT EXISTS invoice_admin_discount_lines (
  id               SERIAL      PRIMARY KEY,
  invoice_id       INTEGER     NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_item_id  INTEGER     NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
  amount_minor     BIGINT      NOT NULL CHECK (amount_minor > 0),
  discounted_at    TIMESTAMPTZ NOT NULL,
  carried_from_id  INTEGER     REFERENCES invoice_admin_discount_lines(id),
  created_by       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS invoice_admin_discount_lines_invoice_idx
  ON invoice_admin_discount_lines (invoice_id, invoice_item_id, discounted_at);

CREATE OR REPLACE FUNCTION aqlan_invoice_admin_discount_line_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'invoice_admin_discount_lines is append-only';
  END IF;
  RAISE EXCEPTION 'invoice_admin_discount_lines is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER invoice_admin_discount_lines_guard
  BEFORE UPDATE OR DELETE ON invoice_admin_discount_lines
  FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_admin_discount_line_guard();

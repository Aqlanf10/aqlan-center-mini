-- (INV-LINK B) Invoice-first clinical linkage: invoice idempotency (payments pattern), the plan item's live financial
-- link (billed_invoice_id), the invoice line's plan item (invoice_items.plan_item_id, copied across corrections) and provenance (origin, origin_invoice_id) on plan items and specialty cases.
-- Additive only: nullable columns and indexes; existing rows stay NULL (provenance unknown), no backfill, no rewrite.
-- Body must remain byte-for-byte equal to INVOICE_LINKAGE_SQL after these comments.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS idempotency_request_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_idempotency_key_uniq
  ON invoices (idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS origin TEXT
  CHECK (origin IS NULL OR origin IN ('plan', 'visit', 'invoice'));
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS origin_invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT;
ALTER TABLE plan_items ADD COLUMN IF NOT EXISTS billed_invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS plan_items_billed_invoice_idx ON plan_items (billed_invoice_id) WHERE billed_invoice_id IS NOT NULL;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS plan_item_id INTEGER REFERENCES plan_items(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS invoice_items_plan_item_idx ON invoice_items (plan_item_id) WHERE plan_item_id IS NOT NULL;
ALTER TABLE clinical_cases ADD COLUMN IF NOT EXISTS origin TEXT
  CHECK (origin IS NULL OR origin IN ('clinical', 'invoice'));
ALTER TABLE clinical_cases ADD COLUMN IF NOT EXISTS origin_invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT;

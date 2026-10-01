-- (P1-C) قرار فوترة شدّة التقويم خارج العقد: لقطة التصنيف عند التوقيع + القرار (فوتِرت/بلا رسوم) ومن قرّر ولماذا.
-- Additive only: nullable columns on ortho_adjustments; existing rows stay NULL (no decision recorded), no backfill.
-- Body must remain byte-for-byte equal to ORTHO_BILLING_DECISION_SQL after these comments.
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_class TEXT;
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_decision TEXT CHECK (billing_decision IN ('billed', 'no_charge'));
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_decision_reason TEXT;
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_decided_by TEXT;
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_decided_at TIMESTAMPTZ;
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_invoice_id INTEGER REFERENCES invoices(id);

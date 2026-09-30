-- (CASE-1) Legacy orthodontic baseline: additive nullable columns on ortho_cases.
-- No backfill, no unique index on ortho_adjustments (see report ortho-duplicate-adjustments).
-- Body must remain byte-for-byte equal to ORTHO_BASELINE_SQL after these comments.
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS baseline_kind TEXT CHECK (baseline_kind IN ('legacy'));
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS baseline_recorded_at TIMESTAMPTZ;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS elastics TEXT;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS responsible_doctor_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT;
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS legacy_financial_mode TEXT
  CHECK (legacy_financial_mode IN ('opening_balance', 'prepaid_included', 'per_session', 'installments'));
ALTER TABLE ortho_cases ADD COLUMN IF NOT EXISTS remaining_objectives TEXT;

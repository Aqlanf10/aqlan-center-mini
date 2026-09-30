-- (REF-1) Extend the existing referral table for internal handoffs. Additive only.
-- Body must remain byte-for-byte equal to INTERNAL_REFERRALS_SQL after these comments.
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'external' CHECK (kind IN ('external', 'internal'));
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS source_case_id INTEGER REFERENCES clinical_cases(id) ON DELETE RESTRICT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS target_case_id INTEGER REFERENCES clinical_cases(id) ON DELETE RESTRICT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS source_plan_item_id INTEGER REFERENCES plan_items(id) ON DELETE RESTRICT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS to_party_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS workflow_state TEXT CHECK (workflow_state IN ('sent', 'accepted', 'needs_appointment', 'scheduled', 'in_treatment', 'completed', 'returned_to_referrer', 'declined', 'cancelled'));
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS clinical_notes TEXT;
ALTER TABLE patient_referrals ADD COLUMN IF NOT EXISTS request_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS patient_referrals_internal_request_idx
  ON patient_referrals (patient_id, request_key) WHERE kind = 'internal' AND request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS patient_referrals_internal_target_idx
  ON patient_referrals (to_party_id, created_at DESC) WHERE kind = 'internal' AND status = 'sent';

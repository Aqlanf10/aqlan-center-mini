-- (P3-8b) Where the patient came from (referral source, and who referred them).
-- Body must remain byte-for-byte equal to PATIENT_SOURCE_SQL after these comments.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS referral_source TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS referred_by TEXT;

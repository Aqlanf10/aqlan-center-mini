-- (P2-8) Patient date of birth, guardian name/phone and national ID (all optional).
-- Body must remain byte-for-byte equal to PATIENT_DEMOGRAPHICS_SQL after these comments.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS guardian_name TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS guardian_phone TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS national_id TEXT;

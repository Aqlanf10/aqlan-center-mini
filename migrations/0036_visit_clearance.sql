-- (CHAIR-1) Reception readiness acknowledgement: when and by whom a visit was cleared for the chair.
-- Additive only: two nullable columns; NULL = not acknowledged (treated exactly as before). visits.status is unchanged.
-- Body must remain byte-for-byte equal to VISIT_CLEARANCE_SQL after these comments.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS cleared_by TEXT;

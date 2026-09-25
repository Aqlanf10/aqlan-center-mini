-- (P3-5) Audit rows record the client IP (behind a trusted proxy only) and user agent.
-- Body must remain byte-for-byte equal to AUDIT_SOURCE_SQL after these comments.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS source_ip TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent TEXT;

-- Additive request metadata only; existing requests retain their original meaning.
ALTER TABLE booking_requests ADD COLUMN request_key TEXT;
ALTER TABLE booking_requests ADD COLUMN request_hash TEXT;
ALTER TABLE booking_requests ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX booking_requests_request_key_idx ON booking_requests (request_key) WHERE request_key IS NOT NULL;

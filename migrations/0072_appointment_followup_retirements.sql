-- Permanent non-commit proof. No live patient/source FK: reset must retain this history.
CREATE TABLE appointment_followup_retirements (
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  source_appointment_id INTEGER NOT NULL CHECK (source_appointment_id > 0),
  source_created_at TEXT NOT NULL CHECK (source_created_at ~ '^[0-9]{1,12}\.[0-9]{6}$'),
  patient_id INTEGER NOT NULL CHECK (patient_id > 0),
  generation TEXT NOT NULL CHECK (generation ~ '^[a-f0-9]{32}$'),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  original_due_at TIMESTAMPTZ NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_user_id, request_id),
  CHECK (original_due_at <= retired_at)
);
CREATE FUNCTION aqlan_followup_attempt_fence() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF NOT EXISTS (SELECT 1 FROM appointment_followup_retirements) THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'followup retirement history is append-only';
  END IF;
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'followup retirement history is append-only'; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('inventory-purchase-reset-v1', 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('appointment-followup:' || NEW.actor_user_id || ':' || NEW.request_id, 0));
  IF TG_TABLE_NAME = 'appointment_followup_retirements' THEN
    IF EXISTS (SELECT 1 FROM appointment_followup_events WHERE actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id)
      OR EXISTS (SELECT 1 FROM appointment_followup_receipts WHERE actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id) THEN
      RAISE EXCEPTION 'followup attempt already committed';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM appointment_followup_retirements WHERE actor_user_id=NEW.actor_user_id AND request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'followup attempt retired';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER appointment_followup_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON appointment_followup_retirements
  FOR EACH ROW EXECUTE FUNCTION aqlan_followup_attempt_fence();
CREATE TRIGGER appointment_followup_retirement_no_truncate BEFORE TRUNCATE ON appointment_followup_retirements
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_followup_attempt_fence();
CREATE TRIGGER appointment_followup_event_retirement_fence BEFORE INSERT ON appointment_followup_events
  FOR EACH ROW EXECUTE FUNCTION aqlan_followup_attempt_fence();
CREATE TRIGGER appointment_followup_receipt_retirement_fence BEFORE INSERT ON appointment_followup_receipts
  FOR EACH ROW EXECUTE FUNCTION aqlan_followup_attempt_fence();

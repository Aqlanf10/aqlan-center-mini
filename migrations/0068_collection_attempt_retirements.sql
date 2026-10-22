-- 0068: a collection attempt key the server proved never committed, retired for good.
-- A client that holds a refused or unanswered collection keeps its key until the server
-- proves the outcome. Retiring writes this row only when no receipt and no split
-- collection group carries the key; afterwards no receipt or group may use it. Both
-- sides take the same per-key transaction lock, so the check and the insert cannot
-- interleave. The row binds the proof to the attempt's patient, operation, request
-- fingerprint and originating user. It is permanent history: no update, no delete, no
-- patient cascade, and TRUNCATE only of an empty table (factory reset refuses first).
-- Validation only: a backup replay re-inserts consistent rows and passes.
CREATE TABLE collection_attempt_retirements (
  idempotency_key TEXT PRIMARY KEY CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  operation TEXT NOT NULL CHECK(operation IN ('payment', 'installment')),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  retired_by TEXT NOT NULL CHECK(length(btrim(retired_by)) BETWEEN 1 AND 200),
  retired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX collection_attempt_retirements_patient_idx ON collection_attempt_retirements(patient_id);
CREATE OR REPLACE FUNCTION aqlan_collection_key_fence() RETURNS TRIGGER AS $$
DECLARE attempt_key TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    -- TRUNCATE holds ACCESS EXCLUSIVE: an empty table loses no proof and no insert can race.
    IF NOT EXISTS(SELECT 1 FROM collection_attempt_retirements) THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'retired collection keys are immutable';
  END IF;
  IF TG_TABLE_NAME = 'collection_attempt_retirements' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'retired collection keys are immutable';
  END IF;
  attempt_key := NEW.idempotency_key;
  IF attempt_key IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('aqlan-collection-key:' || attempt_key, 0));
  IF TG_TABLE_NAME = 'collection_attempt_retirements' THEN
    IF EXISTS(SELECT 1 FROM payments WHERE idempotency_key = attempt_key)
      OR EXISTS(SELECT 1 FROM agreement_delta_collection_receipts WHERE idempotency_key = attempt_key) THEN
      RAISE EXCEPTION 'collection key already committed'; END IF;
  ELSIF EXISTS(SELECT 1 FROM collection_attempt_retirements WHERE idempotency_key = attempt_key) THEN
    RAISE EXCEPTION 'collection key was retired';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER collection_attempt_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON collection_attempt_retirements
  FOR EACH ROW EXECUTE FUNCTION aqlan_collection_key_fence();
CREATE TRIGGER collection_attempt_retirement_truncate BEFORE TRUNCATE ON collection_attempt_retirements
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_collection_key_fence();
CREATE TRIGGER collection_key_retirement_fence BEFORE INSERT ON payments
  FOR EACH ROW WHEN (NEW.idempotency_key IS NOT NULL) EXECUTE FUNCTION aqlan_collection_key_fence();
CREATE TRIGGER collection_key_retirement_fence BEFORE INSERT ON agreement_delta_collection_receipts
  FOR EACH ROW EXECUTE FUNCTION aqlan_collection_key_fence();

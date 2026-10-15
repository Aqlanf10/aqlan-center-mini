-- INERT PROPOSAL: no migration number reserved, no runtime registration.
-- Apply only in explicitly owned disposable tests after exact reviewed0056/0057.
CREATE TABLE hr_temporal_write_receipts (
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('employment.record','schedule.record')),
  request_id TEXT NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'),
  staff_id INTEGER NOT NULL REFERENCES hr_staff(id) ON DELETE RESTRICT,
  stream_id BIGINT NOT NULL,
  revision INTEGER NOT NULL,
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  intent_canonical TEXT NOT NULL,
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent)='object'),
  response JSONB NOT NULL CHECK (jsonb_typeof(response)='object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_user_id,operation,request_id),
  UNIQUE(stream_id,revision),
  FOREIGN KEY(stream_id,revision) REFERENCES hr_effective_revisions(stream_id,revision) ON DELETE RESTRICT,
  CHECK (intent_canonical::jsonb=intent AND intent_digest=encode(sha256(convert_to(intent_canonical,'UTF8')),'hex')),
  CHECK ((intent->>'requestId'=request_id AND (intent->>'staffId')::int=staff_id
    AND intent->>'operation'=operation AND (intent->>'expectedRevision')::int=revision-1) IS TRUE),
  CHECK ((response->>'requestId'=request_id AND (response->>'staffId')::int=staff_id
    AND response->>'operation'=operation AND (response->>'revision')::int=revision
    AND (response->>'actorUserId')::int=actor_user_id AND response->>'intentDigest'=intent_digest
    AND response->>'actorUsername'=intent->>'expectedUsername'
    AND response->'intent'=intent AND response->>'activation'='documented_only') IS TRUE)
);
CREATE FUNCTION aqlan_hr_validate_temporal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hr_effective_streams s JOIN hr_effective_revisions r ON r.stream_id=s.id
    WHERE s.id=NEW.stream_id AND s.staff_id=NEW.staff_id AND s.kind||'.record'=NEW.operation
      AND r.revision=NEW.revision AND r.actor_user_id=NEW.actor_user_id AND r.snapshot=NEW.response->'timeline'
      AND r.recorded_at=(NEW.response->>'recordedAt')::timestamptz
  ) THEN RAISE EXCEPTION 'invalid_temporal_receipt' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hr_temporal_receipt_validate BEFORE INSERT ON hr_temporal_write_receipts
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_validate_temporal_receipt();
CREATE TRIGGER hr_temporal_receipt_immutable BEFORE UPDATE OR DELETE ON hr_temporal_write_receipts
  FOR EACH ROW EXECUTE FUNCTION aqlan_hr_effective_append_only();
CREATE TRIGGER hr_temporal_receipt_no_truncate BEFORE TRUNCATE ON hr_temporal_write_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_hr_effective_append_only();

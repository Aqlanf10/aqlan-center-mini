/** Mirrored numbered migration; no runtime-only DDL or receipt lease. */
export const PRESCRIPTION_ISSUANCE_SQL = String.raw`-- A command is reserved and completed in the same transaction as its Rx and audit.
-- No lease, expiry, reclaim, receipt deletion or mutation of completed commands.
CREATE TABLE prescription_issuance_commands (
  command_key UUID PRIMARY KEY,
  actor_user_id INTEGER NOT NULL CHECK (actor_user_id > 0),
  actor_username TEXT NOT NULL CHECK (length(actor_username) BETWEEN 1 AND 200),
  patient_id INTEGER NOT NULL CHECK (patient_id > 0),
  visit_id INTEGER CHECK (visit_id > 0),
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  prescription_id INTEGER UNIQUE REFERENCES prescriptions(id) ON DELETE RESTRICT,
  warning_fingerprint TEXT CHECK (warning_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE FUNCTION aqlan_prescription_command_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PRESCRIPTION_COMMAND_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD.prescription_id IS NOT NULL OR
    (to_jsonb(NEW) - 'prescription_id' - 'warning_fingerprint') IS DISTINCT FROM
    (to_jsonb(OLD) - 'prescription_id' - 'warning_fingerprint') THEN
    RAISE EXCEPTION 'PRESCRIPTION_COMMAND_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prescription_command_immutable
BEFORE UPDATE OR DELETE ON prescription_issuance_commands
FOR EACH ROW EXECUTE FUNCTION aqlan_prescription_command_immutable();
CREATE FUNCTION aqlan_prescription_command_complete() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE receipt prescription_issuance_commands%ROWTYPE;
BEGIN
  -- NEW from the initial reservation is still null after a later UPDATE. Read
  -- the final row, rather than rejecting that captured pre-completion tuple.
  SELECT * INTO receipt FROM prescription_issuance_commands WHERE command_key = NEW.command_key;
  IF NOT FOUND OR receipt.prescription_id IS NULL THEN
    RAISE EXCEPTION 'PRESCRIPTION_COMMAND_INCOMPLETE' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM prescriptions rx WHERE rx.id = receipt.prescription_id
    AND rx.patient_id = receipt.patient_id AND rx.visit_id IS NOT DISTINCT FROM receipt.visit_id
    AND rx.created_by = receipt.actor_username) THEN
    RAISE EXCEPTION 'PRESCRIPTION_COMMAND_BINDING_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER prescription_command_complete
AFTER INSERT OR UPDATE ON prescription_issuance_commands
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION aqlan_prescription_command_complete();
CREATE FUNCTION aqlan_prescription_command_truncate() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM prescription_issuance_commands) THEN
    RAISE EXCEPTION 'PRESCRIPTION_COMMAND_HISTORY_RETAINED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER prescription_command_truncate
BEFORE TRUNCATE ON prescription_issuance_commands
FOR EACH STATEMENT EXECUTE FUNCTION aqlan_prescription_command_truncate();
`;

-- UNNUMBERED PROPOSAL ONLY. Not registered or run by ensureSchema/migrate.
-- Reserve no migration number; 0073–0080 belong to other workstreams.
-- Documentary state only: no invoice status, debt, receipt, clinical or commission mutation.
CREATE TABLE IF NOT EXISTS invoice_archive_events (
  id BIGSERIAL PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL,
  invoice_created_at TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL CONSTRAINT invoice_archive_currency CHECK (currency IN ('YER','SAR','USD')),
  version INTEGER NOT NULL CONSTRAINT invoice_archive_version_positive CHECK (version > 0),
  action TEXT NOT NULL CONSTRAINT invoice_archive_action CHECK (action IN ('archive','restore')),
  reason TEXT NOT NULL CONSTRAINT invoice_archive_reason CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  idempotency_key TEXT NOT NULL UNIQUE CONSTRAINT invoice_archive_key CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CONSTRAINT invoice_archive_hash CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL CONSTRAINT invoice_archive_actor CHECK (length(btrim(actor)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT invoice_archive_invoice_version UNIQUE (invoice_id, version)
);
CREATE INDEX IF NOT EXISTS invoice_archive_patient_idx ON invoice_archive_events(patient_id, invoice_id, version DESC);

CREATE OR REPLACE FUNCTION aqlan_invoice_archive_event_guard() RETURNS TRIGGER AS $$
DECLARE target invoices%ROWTYPE; previous invoice_archive_events%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'invoice archive evidence is append-only'; END IF;
  SELECT * INTO target FROM invoices WHERE id=NEW.invoice_id FOR UPDATE;
  IF target.id IS NULL OR target.patient_id <> NEW.patient_id OR target.invoice_number <> NEW.invoice_number
    OR target.created_at <> NEW.invoice_created_at OR target.base_currency <> NEW.currency THEN
    RAISE EXCEPTION 'invoice archive ownership mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.actor_user_id AND username=NEW.actor AND role='admin' AND is_active=TRUE) THEN
    RAISE EXCEPTION 'invoice archive actor mismatch';
  END IF;
  SELECT * INTO previous FROM invoice_archive_events WHERE invoice_id=NEW.invoice_id ORDER BY version DESC LIMIT 1;
  IF NEW.version <> COALESCE(previous.version,0)+1 OR NEW.action=COALESCE(previous.action,'restore') THEN
    RAISE EXCEPTION 'invoice archive version/state mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER invoice_archive_events_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_archive_events
  FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_archive_event_guard();

CREATE OR REPLACE TRIGGER invoice_archive_events_no_truncate BEFORE TRUNCATE ON invoice_archive_events
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_invoice_archive_event_guard();

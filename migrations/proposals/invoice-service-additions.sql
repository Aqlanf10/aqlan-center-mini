-- UNNUMBERED PROPOSAL. Not part of runtime bootstrap or the migration registry.
-- Assign a version only after cross-branch schema review; 0073–0080 are reserved.
CREATE TABLE invoice_service_additions (
  id BIGSERIAL PRIMARY KEY,
  original_invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  additional_invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  currency TEXT NOT NULL CHECK (currency IN ('YER','SAR','USD')),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (original_invoice_id<>additional_invoice_id)
);
CREATE INDEX invoice_service_additions_original_idx ON invoice_service_additions(original_invoice_id,id);
CREATE TABLE invoice_service_addition_rejections (
  idempotency_key TEXT PRIMARY KEY CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  original_invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  expected_source_hash TEXT NOT NULL CHECK (expected_source_hash ~ '^[a-f0-9]{64}$'),
  observed_source_hash TEXT NOT NULL CHECK (observed_source_hash ~ '^[a-f0-9]{64}$'),
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION aqlan_invoice_service_addition_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'invoice service addition evidence is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_service_additions_immutable BEFORE UPDATE OR DELETE ON invoice_service_additions
  FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_service_addition_immutable();
CREATE TRIGGER invoice_service_additions_no_truncate BEFORE TRUNCATE ON invoice_service_additions
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_invoice_service_addition_immutable();
CREATE TRIGGER invoice_service_addition_rejections_immutable BEFORE UPDATE OR DELETE ON invoice_service_addition_rejections
  FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_service_addition_immutable();
CREATE TRIGGER invoice_service_addition_rejections_no_truncate BEFORE TRUNCATE ON invoice_service_addition_rejections
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_invoice_service_addition_immutable();
CREATE FUNCTION aqlan_invoice_service_addition_validate() RETURNS TRIGGER AS $$
DECLARE original invoices%ROWTYPE; additional invoices%ROWTYPE;
BEGIN
  SELECT * INTO original FROM invoices WHERE id=NEW.original_invoice_id;
  SELECT * INTO additional FROM invoices WHERE id=NEW.additional_invoice_id;
  IF original.id IS NULL OR additional.id IS NULL OR original.status='cancelled'
    OR original.patient_id<>NEW.patient_id OR additional.patient_id<>NEW.patient_id
    OR original.base_currency<>NEW.currency OR additional.base_currency<>NEW.currency
    OR additional.total_minor-additional.discount_minor<=0
    OR additional.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR additional.created_by IS DISTINCT FROM NEW.created_by
    OR (SELECT count(*) FROM invoice_items WHERE invoice_id=additional.id)<>1
    OR EXISTS(SELECT 1 FROM invoice_service_addition_rejections WHERE idempotency_key=NEW.idempotency_key)
    OR (NEW.receipt->>'originalInvoiceId')::integer IS DISTINCT FROM original.id
    OR (NEW.receipt->>'additionalInvoiceId')::integer IS DISTINCT FROM additional.id
    OR NEW.receipt->>'additionalInvoiceNumber' IS DISTINCT FROM additional.invoice_number
    OR (NEW.receipt->>'patientId')::integer IS DISTINCT FROM NEW.patient_id
    OR NEW.receipt->>'currency' IS DISTINCT FROM NEW.currency
    OR NEW.receipt->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
    OR NEW.receipt->>'requestHash' IS DISTINCT FROM NEW.request_hash
    OR NEW.receipt->>'createdBy' IS DISTINCT FROM NEW.created_by
    OR (NEW.receipt->>'addedNetMinor')::bigint IS DISTINCT FROM additional.total_minor-additional.discount_minor
    OR (NEW.receipt->>'cashMovementMinor')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'invoice service addition ownership or acknowledgement mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_service_additions_validate BEFORE INSERT ON invoice_service_additions
  FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_service_addition_validate();

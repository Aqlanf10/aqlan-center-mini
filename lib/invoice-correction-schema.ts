/** Canonical invoice correction lineage; byte-identical to migration 0061. */
export const INVOICE_CORRECTION_SQL = `CREATE TABLE IF NOT EXISTS invoice_corrections (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency IN ('YER','SAR','USD')),
  original_invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE CASCADE,
  corrected_invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (original_invoice_id <> corrected_invoice_id)
);

CREATE TABLE IF NOT EXISTS invoice_correction_receipts (
  correction_id INTEGER PRIMARY KEY REFERENCES invoice_corrections(id) ON DELETE CASCADE,
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object')
);

CREATE TABLE IF NOT EXISTS invoice_correction_lines (
  id SERIAL PRIMARY KEY,
  correction_id INTEGER NOT NULL REFERENCES invoice_corrections(id) ON DELETE CASCADE,
  original_item_id INTEGER REFERENCES invoice_items(id),
  corrected_item_id INTEGER NOT NULL UNIQUE REFERENCES invoice_items(id),
  plan_item_id INTEGER REFERENCES plan_items(id),
  approved_work JSONB NOT NULL CHECK (jsonb_typeof(approved_work) = 'object'),
  UNIQUE(correction_id, original_item_id)
);

CREATE OR REPLACE FUNCTION aqlan_invoice_correction_guard() RETURNS TRIGGER AS $$
DECLARE owner_patient INTEGER; original invoices%ROWTYPE; corrected invoices%ROWTYPE;
        correction invoice_corrections%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_TABLE_NAME = 'invoice_corrections' THEN owner_patient := OLD.patient_id;
    ELSE SELECT patient_id INTO owner_patient FROM invoice_corrections WHERE id = OLD.correction_id;
    END IF;
    IF TG_OP = 'DELETE' AND (owner_patient IS NULL OR NOT EXISTS (SELECT 1 FROM patients WHERE id = owner_patient)) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'invoice correction evidence is append-only';
  END IF;
  IF TG_TABLE_NAME = 'invoice_corrections' THEN
    SELECT * INTO original FROM invoices WHERE id = NEW.original_invoice_id;
    SELECT * INTO corrected FROM invoices WHERE id = NEW.corrected_invoice_id;
    IF original.id IS NULL OR corrected.id IS NULL OR original.patient_id <> NEW.patient_id OR corrected.patient_id <> NEW.patient_id
      OR original.base_currency <> NEW.currency OR corrected.base_currency <> NEW.currency THEN
      RAISE EXCEPTION 'invoice correction patient/currency mismatch';
    END IF;
    IF EXISTS (WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.original_invoice_id UNION SELECT c.original_invoice_id FROM invoice_corrections c JOIN ancestors a ON c.corrected_invoice_id = a.id
    ) SELECT 1 FROM ancestors WHERE id = NEW.corrected_invoice_id) THEN RAISE EXCEPTION 'invoice correction cycle'; END IF;
  ELSIF TG_TABLE_NAME = 'invoice_correction_lines' THEN
    SELECT * INTO correction FROM invoice_corrections WHERE id = NEW.correction_id;
    IF NOT EXISTS (SELECT 1 FROM invoice_items i WHERE i.id = NEW.corrected_item_id AND i.invoice_id = correction.corrected_invoice_id
        AND i.plan_item_id IS NOT DISTINCT FROM NEW.plan_item_id
        AND (NEW.plan_item_id IS NULL OR (NEW.approved_work->>'serviceId')::int IS NOT DISTINCT FROM i.service_id
          AND (NEW.approved_work->>'doctorId')::int IS NOT DISTINCT FROM i.doctor_id
          AND (NEW.approved_work->>'quantity')::int = i.quantity
          AND (NEW.approved_work->>'unitPriceMinor')::bigint = i.unit_price_minor))
      OR (NEW.original_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoice_items i WHERE i.id = NEW.original_item_id AND i.invoice_id = correction.original_invoice_id))
      OR (NEW.plan_item_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plan_items i JOIN treatment_plans p ON p.id = i.plan_id
        WHERE i.id = NEW.plan_item_id AND p.patient_id = correction.patient_id AND p.base_currency = correction.currency)) THEN
      RAISE EXCEPTION 'invoice correction line ownership mismatch';
    END IF;
  ELSIF TG_TABLE_NAME = 'invoice_correction_receipts' THEN
    SELECT * INTO correction FROM invoice_corrections WHERE id = NEW.correction_id;
    IF (NEW.receipt->>'patientId')::int IS DISTINCT FROM correction.patient_id
      OR NEW.receipt->>'currency' IS DISTINCT FROM correction.currency
      OR NEW.receipt->>'idempotencyKey' IS DISTINCT FROM correction.idempotency_key
      OR NEW.receipt->>'createdBy' IS DISTINCT FROM correction.created_by
      OR (NEW.receipt#>>'{original,id}')::int IS DISTINCT FROM correction.original_invoice_id
      OR (NEW.receipt#>>'{corrected,id}')::int IS DISTINCT FROM correction.corrected_invoice_id
      OR (NEW.receipt#>>'{original,patientId}')::int IS DISTINCT FROM correction.patient_id
      OR (NEW.receipt#>>'{corrected,patientId}')::int IS DISTINCT FROM correction.patient_id
      OR NEW.receipt#>>'{original,baseCurrency}' IS DISTINCT FROM correction.currency
      OR NEW.receipt#>>'{corrected,baseCurrency}' IS DISTINCT FROM correction.currency THEN
      RAISE EXCEPTION 'invoice correction acknowledgement ownership mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER invoice_corrections_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_corrections
  FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_correction_guard();
CREATE OR REPLACE TRIGGER invoice_correction_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_correction_lines
  FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_correction_guard();
CREATE OR REPLACE TRIGGER invoice_correction_receipts_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_correction_receipts
  FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_correction_guard();

CREATE OR REPLACE FUNCTION aqlan_invoice_correction_complete() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoice_corrections WHERE id = NEW.id)
    AND NOT EXISTS (SELECT 1 FROM invoice_correction_receipts WHERE correction_id = NEW.id) THEN
    RAISE EXCEPTION 'invoice correction acknowledgement missing';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS invoice_corrections_complete ON invoice_corrections;
CREATE CONSTRAINT TRIGGER invoice_corrections_complete AFTER INSERT ON invoice_corrections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aqlan_invoice_correction_complete();
`;

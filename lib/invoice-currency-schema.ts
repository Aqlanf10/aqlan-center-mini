export const INVOICE_CURRENCY_RECLASSIFICATION_SQL = `-- 0063: non-cash, per-receipt settlement reclassification. No cash rewrite.
ALTER TABLE invoice_corrections ADD COLUMN IF NOT EXISTS original_currency TEXT
  CHECK (original_currency IN ('YER','SAR','USD'));
CREATE TABLE invoice_settlement_reclassifications (
  id SERIAL PRIMARY KEY,
  correction_id INTEGER NOT NULL UNIQUE REFERENCES invoice_corrections(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  source_currency TEXT NOT NULL CHECK (source_currency='YER'),
  target_currency TEXT NOT NULL CHECK (target_currency='SAR'),
  source_invoice_ids INTEGER[] NOT NULL CHECK (cardinality(source_invoice_ids)>0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE invoice_settlement_reclassification_events (
  id SERIAL PRIMARY KEY,
  reclassification_id INTEGER NOT NULL REFERENCES invoice_settlement_reclassifications(id) ON DELETE CASCADE,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id) ON DELETE CASCADE,
  direction SMALLINT NOT NULL CHECK (direction IN (-1,1)),
  source_minor BIGINT NOT NULL CHECK (source_minor>=0),
  target_minor BIGINT NOT NULL CHECK (target_minor>=0),
  payment_snapshot JSONB NOT NULL CHECK (jsonb_typeof(payment_snapshot)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX invoice_reclassification_patient_idx ON invoice_settlement_reclassifications(patient_id);
CREATE INDEX invoice_reclassification_event_document_idx ON invoice_settlement_reclassification_events(reclassification_id);
CREATE OR REPLACE FUNCTION aqlan_reclassification_guard() RETURNS TRIGGER AS $$
DECLARE document invoice_settlement_reclassifications%ROWTYPE; correction invoice_corrections%ROWTYPE;
  receipt payments%ROWTYPE; owner_patient INTEGER; expected_ids INTEGER[];
BEGIN
  IF TG_TABLE_NAME='invoice_settlement_reclassifications' THEN owner_patient:=COALESCE(NEW.patient_id,OLD.patient_id);
  ELSE SELECT patient_id INTO owner_patient FROM invoice_settlement_reclassifications WHERE id=COALESCE(NEW.reclassification_id,OLD.reclassification_id); END IF;
  IF TG_OP<>'INSERT' THEN
    IF TG_OP='DELETE' AND (owner_patient IS NULL OR NOT EXISTS(SELECT 1 FROM patients WHERE id=owner_patient)) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'settlement reclassification evidence is append-only';
  END IF;
  IF TG_TABLE_NAME='invoice_settlement_reclassifications' THEN
    SELECT * INTO correction FROM invoice_corrections WHERE id=NEW.correction_id;
    IF correction.id IS NULL OR correction.patient_id<>NEW.patient_id
      OR correction.original_currency IS DISTINCT FROM NEW.source_currency OR correction.currency<>NEW.target_currency THEN
      RAISE EXCEPTION 'reclassification correction ownership mismatch'; END IF;
    WITH RECURSIVE lineage(id) AS (SELECT correction.original_invoice_id UNION
      SELECT c.original_invoice_id FROM invoice_corrections c JOIN lineage l ON c.corrected_invoice_id=l.id)
      SELECT array_agg(id ORDER BY id) INTO expected_ids FROM lineage;
    IF NEW.source_invoice_ids IS DISTINCT FROM expected_ids
      OR EXISTS(SELECT 1 FROM invoices WHERE id=ANY(expected_ids) AND (patient_id<>NEW.patient_id OR base_currency<>NEW.source_currency OR status<>'cancelled'))
      OR EXISTS(SELECT 1 FROM invoice_settlement_reclassifications WHERE source_invoice_ids && expected_ids) THEN
      RAISE EXCEPTION 'unsupported reclassification lineage'; END IF;
  ELSE
    SELECT * INTO document FROM invoice_settlement_reclassifications WHERE id=NEW.reclassification_id;
    SELECT * INTO receipt FROM payments WHERE id=NEW.payment_id;
    IF document.id IS NULL OR receipt.id IS NULL OR receipt.patient_id<>document.patient_id
      OR receipt.invoice_id IS NULL OR NOT(receipt.invoice_id=ANY(document.source_invoice_ids))
      OR receipt.currency<>document.target_currency OR receipt.base_currency<>document.source_currency
      OR receipt.exchange_rate<=0 OR receipt.base_amount_minor<>FLOOR(receipt.amount_minor::double precision/100*receipt.exchange_rate::double precision+0.5)
      OR NEW.source_minor<>receipt.base_amount_minor OR NEW.target_minor<>receipt.amount_minor
      OR NEW.direction<>(CASE WHEN receipt.kind='payment' THEN 1 WHEN receipt.kind='refund' THEN -1 ELSE 0 END)
      OR NEW.payment_snapshot IS DISTINCT FROM to_jsonb(receipt) THEN
      RAISE EXCEPTION 'reclassification payment proof mismatch'; END IF;
    IF receipt.kind='refund' AND NOT EXISTS(SELECT 1 FROM payments original
      WHERE original.id=receipt.reversal_of_id AND original.kind='payment' AND original.patient_id=receipt.patient_id
        AND original.invoice_id=receipt.invoice_id AND original.currency=receipt.currency AND original.exchange_rate=receipt.exchange_rate) THEN
      RAISE EXCEPTION 'reclassification refund proof mismatch'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_reclassification_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_settlement_reclassifications
 FOR EACH ROW EXECUTE FUNCTION aqlan_reclassification_guard();
CREATE TRIGGER invoice_reclassification_event_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_settlement_reclassification_events
 FOR EACH ROW EXECUTE FUNCTION aqlan_reclassification_guard();
CREATE OR REPLACE FUNCTION aqlan_reclassification_complete() RETURNS TRIGGER AS $$
DECLARE document invoice_settlement_reclassifications%ROWTYPE;
BEGIN
  SELECT * INTO document FROM invoice_settlement_reclassifications WHERE correction_id=NEW.id;
  IF NEW.original_currency IS NOT NULL AND NEW.original_currency<>NEW.currency THEN
    IF document.id IS NULL OR EXISTS(SELECT 1 FROM payments p WHERE p.invoice_id=ANY(document.source_invoice_ids)
      AND NOT EXISTS(SELECT 1 FROM invoice_settlement_reclassification_events e WHERE e.reclassification_id=document.id AND e.payment_id=p.id)) THEN
      RAISE EXCEPTION 'reclassification settlement coverage incomplete'; END IF;
  ELSIF document.id IS NOT NULL THEN RAISE EXCEPTION 'unexpected reclassification document'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER invoice_reclassification_complete AFTER INSERT ON invoice_corrections
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aqlan_reclassification_complete();
CREATE OR REPLACE FUNCTION aqlan_reclassification_follow_refund() RETURNS TRIGGER AS $$
DECLARE document invoice_settlement_reclassifications%ROWTYPE;
BEGIN
  SELECT * INTO document FROM invoice_settlement_reclassifications WHERE NEW.invoice_id=ANY(source_invoice_ids);
  IF document.id IS NULL THEN RETURN NEW; END IF;
  IF NEW.kind<>'refund' OR NOT EXISTS(SELECT 1 FROM invoice_settlement_reclassification_events
    WHERE payment_id=NEW.reversal_of_id AND reclassification_id=document.id AND direction=1) THEN
    RAISE EXCEPTION 'collect on the current corrected invoice; historical settlement is immutable'; END IF;
  INSERT INTO invoice_settlement_reclassification_events(reclassification_id,payment_id,direction,source_minor,target_minor,payment_snapshot)
    VALUES(document.id,NEW.id,-1,NEW.base_amount_minor,NEW.amount_minor,to_jsonb(NEW));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_reclassification_follow_refund AFTER INSERT ON payments
 FOR EACH ROW EXECUTE FUNCTION aqlan_reclassification_follow_refund();
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
      OR original.base_currency <> COALESCE(NEW.original_currency,NEW.currency) OR corrected.base_currency <> NEW.currency THEN
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
      OR NEW.receipt#>>'{original,baseCurrency}' IS DISTINCT FROM COALESCE(correction.original_currency,correction.currency)
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

`;

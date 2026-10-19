// Shared verbatim runtime/CLI migration; no historical backfill.
export const APPROVED_AGREEMENT_SQL = `-- Explicit financial approval only. No historical backfill or debt posting.
CREATE TABLE IF NOT EXISTS approved_agreement_principals (
  plan_id INTEGER PRIMARY KEY REFERENCES treatment_plans(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  currency TEXT NOT NULL CHECK (currency IN ('YER','SAR','USD')),
  total_minor BIGINT NOT NULL CHECK (total_minor BETWEEN 1 AND 9007199254740991),
  historical_paid_minor BIGINT NOT NULL DEFAULT 0 CHECK (historical_paid_minor BETWEEN 0 AND 9007199254740991),
  invoice_id INTEGER UNIQUE REFERENCES invoices(id),
  opening_currency TEXT CHECK (opening_currency IN ('YER','SAR','USD')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('new','invoice','opening')),
  terms JSONB NOT NULL CHECK (jsonb_typeof(terms)='object'),
  source_snapshot JSONB NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (historical_paid_minor <= total_minor),
  CHECK ((source_kind IN ('new','invoice') AND invoice_id IS NOT NULL AND opening_currency IS NULL AND historical_paid_minor=0)
    OR (source_kind='opening' AND invoice_id IS NULL AND opening_currency=currency))
);
CREATE UNIQUE INDEX IF NOT EXISTS approved_agreement_opening_unique
  ON approved_agreement_principals(patient_id,opening_currency) WHERE opening_currency IS NOT NULL;
CREATE OR REPLACE FUNCTION aqlan_approved_agreement_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'approved agreement history is immutable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM treatment_plans WHERE id=NEW.plan_id AND patient_id=NEW.patient_id
    AND base_currency=NEW.currency AND total_minor=NEW.total_minor AND status<>'cancelled' AND consent_at IS NOT NULL)
    THEN RAISE EXCEPTION 'approved agreement plan mismatch'; END IF;
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM invoices WHERE id=NEW.invoice_id
    AND patient_id=NEW.patient_id AND base_currency=NEW.currency AND status<>'cancelled'
    AND total_minor-discount_minor=NEW.total_minor)
    THEN RAISE EXCEPTION 'approved agreement invoice mismatch'; END IF;
  IF NEW.opening_currency IS NOT NULL AND NOT EXISTS (SELECT 1 FROM patient_opening_balances
    WHERE patient_id=NEW.patient_id AND currency=NEW.currency AND amount_minor=NEW.total_minor-NEW.historical_paid_minor)
    THEN RAISE EXCEPTION 'approved agreement opening mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER approved_agreement_guard BEFORE INSERT OR UPDATE OR DELETE ON approved_agreement_principals
  FOR EACH ROW EXECUTE FUNCTION aqlan_approved_agreement_guard();

CREATE OR REPLACE FUNCTION aqlan_approved_agreement_terms_guard() RETURNS TRIGGER AS $$
DECLARE target_plan INTEGER;
BEGIN
  IF TG_TABLE_NAME='treatment_plans' THEN
    IF EXISTS (SELECT 1 FROM approved_agreement_principals WHERE plan_id=OLD.id) THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'approved agreement requires financial review'; END IF;
      IF (NEW.patient_id,NEW.base_currency,NEW.total_minor) IS DISTINCT FROM (OLD.patient_id,OLD.base_currency,OLD.total_minor)
        OR NEW.status='cancelled' AND OLD.status<>'cancelled'
        THEN RAISE EXCEPTION 'approved agreement requires financial review'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='plan_items' THEN
    target_plan := CASE WHEN TG_OP='INSERT' THEN NEW.plan_id ELSE OLD.plan_id END;
    IF EXISTS (SELECT 1 FROM approved_agreement_principals WHERE plan_id=target_plan
      OR (TG_OP='UPDATE' AND plan_id=NEW.plan_id)) THEN
      IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'approved agreement additions require new approval'; END IF;
      IF (NEW.plan_id,NEW.service_id,NEW.quantity,NEW.unit_price_minor,NEW.doctor_id,NEW.billing_rule,NEW.session_count)
        IS DISTINCT FROM (OLD.plan_id,OLD.service_id,OLD.quantity,OLD.unit_price_minor,OLD.doctor_id,OLD.billing_rule,OLD.session_count)
        OR NEW.status='cancelled' AND OLD.status<>'cancelled'
        THEN RAISE EXCEPTION 'approved agreement terms require financial review'; END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER approved_plan_terms_guard BEFORE UPDATE OR DELETE ON treatment_plans
  FOR EACH ROW EXECUTE FUNCTION aqlan_approved_agreement_terms_guard();
CREATE OR REPLACE TRIGGER approved_item_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON plan_items
  FOR EACH ROW EXECUTE FUNCTION aqlan_approved_agreement_terms_guard();

-- Freeze the financial source and schedule after approval. Clinical completion
-- and receipt/refund movements remain independent of the principal.
CREATE OR REPLACE FUNCTION aqlan_approved_agreement_source_guard() RETURNS TRIGGER AS $$
DECLARE protected BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME='invoices' THEN
    IF TG_OP='INSERT' THEN
      IF EXISTS(SELECT 1 FROM approved_agreement_principals WHERE plan_id=NEW.plan_id) THEN
        RAISE EXCEPTION 'approved agreement cannot issue another principal';
      END IF;
      RETURN NEW;
    END IF;
    protected := EXISTS(SELECT 1 FROM approved_agreement_principals WHERE invoice_id=OLD.id);
    IF protected AND TG_OP='UPDATE' THEN
      IF (NEW.patient_id,NEW.base_currency,NEW.total_minor,NEW.discount_minor,NEW.plan_id,NEW.status,NEW.created_at)
        IS NOT DISTINCT FROM (OLD.patient_id,OLD.base_currency,OLD.total_minor,OLD.discount_minor,OLD.plan_id,OLD.status,OLD.created_at) THEN RETURN NEW; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='patient_opening_balances' THEN
    protected := EXISTS(SELECT 1 FROM approved_agreement_principals WHERE patient_id=OLD.patient_id AND opening_currency=OLD.currency);
  ELSIF TG_TABLE_NAME='plan_installments' THEN
    protected := EXISTS(SELECT 1 FROM approved_agreement_principals WHERE plan_id=CASE WHEN TG_OP='INSERT' THEN NEW.plan_id ELSE OLD.plan_id END
      OR (TG_OP='UPDATE' AND plan_id=NEW.plan_id));
    IF protected AND TG_OP='UPDATE' THEN
      IF (NEW.plan_id,NEW.number,NEW.due_date,NEW.amount_minor) IS NOT DISTINCT FROM (OLD.plan_id,OLD.number,OLD.due_date,OLD.amount_minor) THEN RETURN NEW; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='invoice_items' THEN
    protected := EXISTS(SELECT 1 FROM approved_agreement_principals WHERE invoice_id=CASE WHEN TG_OP='INSERT' THEN NEW.invoice_id ELSE OLD.invoice_id END
      OR (TG_OP='UPDATE' AND invoice_id=NEW.invoice_id));
  END IF;
  IF protected THEN RAISE EXCEPTION 'approved agreement source requires financial review'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER approved_invoice_source_guard BEFORE INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION aqlan_approved_agreement_source_guard();
CREATE OR REPLACE TRIGGER approved_opening_source_guard BEFORE UPDATE OR DELETE ON patient_opening_balances
  FOR EACH ROW EXECUTE FUNCTION aqlan_approved_agreement_source_guard();
CREATE OR REPLACE TRIGGER approved_installments_source_guard BEFORE INSERT OR UPDATE OR DELETE ON plan_installments
  FOR EACH ROW EXECUTE FUNCTION aqlan_approved_agreement_source_guard();
CREATE OR REPLACE TRIGGER approved_invoice_items_source_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION aqlan_approved_agreement_source_guard();
`;

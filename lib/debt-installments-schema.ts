/** Byte-identical additive DDL shared by bootstrap and migration 0059. */
export const DEBT_INSTALLMENTS_SQL = `-- 0059 allocated by root on 2026-10-12. Gaps 0044–0058 are intentional on this branch.
-- A schedule allocates existing debt. These tables never post invoices, receipts or cash.
CREATE OR REPLACE FUNCTION aqlan_debt_terms_valid(terms JSONB, principal BIGINT) RETURNS BOOLEAN AS $$
DECLARE entry JSONB; amount BIGINT; total NUMERIC := 0; previous_date DATE; due DATE; index INTEGER := 0;
BEGIN
  IF jsonb_typeof(terms) <> 'object' OR principal < 0 OR principal > 9007199254740991
    OR (terms - ARRAY['mode','installments']) <> '{}'::jsonb
    OR jsonb_typeof(terms->'installments') <> 'array' THEN RETURN FALSE; END IF;
  IF terms->>'mode' = 'full' THEN RETURN jsonb_array_length(terms->'installments') = 0; END IF;
  IF terms->>'mode' IS DISTINCT FROM 'installments' OR principal = 0
    OR jsonb_array_length(terms->'installments') NOT BETWEEN 1 AND 60 THEN RETURN FALSE; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(terms->'installments') LOOP
    IF jsonb_typeof(entry) <> 'object' OR (entry - ARRAY['dueDate','amountMinor','kind']) <> '{}'::jsonb
      OR jsonb_typeof(entry->'amountMinor') IS DISTINCT FROM 'number'
      OR (entry->>'amountMinor') !~ '^[0-9]+$'
      OR jsonb_typeof(entry->'dueDate') IS DISTINCT FROM 'string'
      OR (entry->>'dueDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR entry->>'kind' NOT IN ('down_payment','installment') OR entry->>'kind' IS NULL
      THEN RETURN FALSE; END IF;
    amount := (entry->>'amountMinor')::bigint;
    due := (entry->>'dueDate')::date;
    IF amount <= 0 OR amount > 9007199254740991 OR to_char(due,'YYYY-MM-DD') <> entry->>'dueDate'
      OR (previous_date IS NOT NULL AND due < previous_date)
      OR (entry->>'kind' = 'down_payment' AND index <> 0) THEN RETURN FALSE; END IF;
    total := total + amount; previous_date := due; index := index + 1;
  END LOOP;
  RETURN total = principal;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE TABLE IF NOT EXISTS debt_repayment_arrangements (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  currency TEXT NOT NULL CHECK (currency IN ('YER','SAR','USD')),
  invoice_id INTEGER REFERENCES invoices(id),
  opening_currency TEXT CHECK (opening_currency IN ('YER','SAR','USD')),
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT debt_repayment_target_check CHECK (
    (invoice_id IS NOT NULL AND opening_currency IS NULL)
    OR (invoice_id IS NULL AND opening_currency IS NOT NULL AND opening_currency = currency))
);
CREATE UNIQUE INDEX IF NOT EXISTS debt_repayment_invoice_uniq ON debt_repayment_arrangements(invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS debt_repayment_opening_uniq ON debt_repayment_arrangements(patient_id,opening_currency) WHERE opening_currency IS NOT NULL;
CREATE INDEX IF NOT EXISTS debt_repayment_patient_idx ON debt_repayment_arrangements(patient_id,id);

CREATE TABLE IF NOT EXISTS debt_repayment_revisions (
  id SERIAL PRIMARY KEY,
  arrangement_id INTEGER NOT NULL REFERENCES debt_repayment_arrangements(id),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('active','cancelled')),
  principal_minor BIGINT NOT NULL CHECK (principal_minor BETWEEN 0 AND 9007199254740991),
  settled_snapshot_minor BIGINT NOT NULL CHECK (settled_snapshot_minor BETWEEN -9007199254740991 AND 9007199254740991),
  source_snapshot JSONB NOT NULL CHECK (jsonb_typeof(source_snapshot) = 'object'),
  terms JSONB NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(arrangement_id,version),
  CONSTRAINT debt_repayment_terms_check CHECK (aqlan_debt_terms_valid(terms,principal_minor) IS TRUE),
  CONSTRAINT debt_repayment_cancel_terms_check CHECK (status = 'active' OR terms->>'mode' = 'full')
);

CREATE OR REPLACE FUNCTION aqlan_debt_repayment_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'debt repayment history is append-only'; END IF;
  IF TG_TABLE_NAME = 'debt_repayment_arrangements' THEN
    IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices WHERE id=NEW.invoice_id AND patient_id=NEW.patient_id AND base_currency=NEW.currency)
      THEN RAISE EXCEPTION 'debt repayment invoice ownership/currency mismatch'; END IF;
    IF NEW.opening_currency IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM patient_opening_balances WHERE patient_id=NEW.patient_id AND currency=NEW.currency)
      THEN RAISE EXCEPTION 'debt repayment opening target missing'; END IF;
  ELSE
    PERFORM id FROM debt_repayment_arrangements WHERE id=NEW.arrangement_id FOR UPDATE;
    IF NEW.version <> COALESCE((SELECT MAX(version) FROM debt_repayment_revisions WHERE arrangement_id=NEW.arrangement_id),0)+1
      THEN RAISE EXCEPTION 'debt repayment revision is stale'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER debt_repayment_arrangements_guard BEFORE INSERT OR UPDATE OR DELETE ON debt_repayment_arrangements
  FOR EACH ROW EXECUTE FUNCTION aqlan_debt_repayment_guard();
CREATE OR REPLACE TRIGGER debt_repayment_revisions_guard BEFORE INSERT OR UPDATE OR DELETE ON debt_repayment_revisions
  FOR EACH ROW EXECUTE FUNCTION aqlan_debt_repayment_guard();
`;

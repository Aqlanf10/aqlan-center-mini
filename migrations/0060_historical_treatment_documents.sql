CREATE TABLE IF NOT EXISTS legacy_treatment_documents (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency IN ('YER','SAR','USD')),
  line_count INTEGER NOT NULL CHECK (line_count BETWEEN 1 AND 40),
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 200),
  created_role TEXT NOT NULL CHECK (created_role IN ('admin','reception')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE legacy_treatment_agreements ADD COLUMN IF NOT EXISTS document_id INTEGER REFERENCES legacy_treatment_documents(id) ON DELETE CASCADE;
ALTER TABLE legacy_treatment_agreements ADD COLUMN IF NOT EXISTS document_line INTEGER;
ALTER TABLE legacy_treatment_agreements ALTER COLUMN previously_paid_minor DROP NOT NULL;
ALTER TABLE legacy_treatment_agreements ALTER COLUMN remaining_minor DROP NOT NULL;
ALTER TABLE legacy_treatment_agreements DROP CONSTRAINT IF EXISTS legacy_treatment_agreements_amounts_check;
ALTER TABLE legacy_treatment_agreements ADD CONSTRAINT legacy_treatment_agreements_amounts_check CHECK (
  (document_id IS NULL AND document_line IS NULL AND previously_paid_minor IS NOT NULL AND remaining_minor IS NOT NULL
    AND previously_paid_minor <= agreed_minor AND remaining_minor = agreed_minor - previously_paid_minor)
  OR (document_id IS NOT NULL AND document_line IS NOT NULL AND document_line BETWEEN 0 AND 39
    AND previously_paid_minor IS NULL AND remaining_minor IS NULL)
);
ALTER TABLE legacy_treatment_agreements DROP CONSTRAINT IF EXISTS legacy_treatment_agreements_opening_check;
ALTER TABLE legacy_treatment_agreements ADD CONSTRAINT legacy_treatment_agreements_opening_check CHECK (
  (document_id IS NULL AND ((remaining_minor = 0 AND opening_effect = 'none' AND opening_history_id IS NULL)
    OR (remaining_minor > 0 AND opening_effect <> 'none' AND opening_history_id IS NOT NULL)))
  OR (document_id IS NOT NULL AND opening_effect = 'none' AND opening_history_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS legacy_treatment_document_line_uniq ON legacy_treatment_agreements(document_id, document_line) WHERE document_id IS NOT NULL;

-- Single teeth retain their original uniqueness. Separate jaw groups can use
-- separate cases; the immutable coverage guard below rejects actual overlap.
DROP INDEX IF EXISTS legacy_treatment_agreements_live_scope_uniq;
CREATE UNIQUE INDEX legacy_treatment_agreements_live_scope_uniq
  ON legacy_treatment_agreements (patient_id, service_id, COALESCE(tooth_code, 0),
    (CASE WHEN tooth_code IS NULL THEN COALESCE(case_id, 0) ELSE 0 END)) WHERE status = 'live';
CREATE OR REPLACE FUNCTION aqlan_legacy_document_coverage_overlap_guard() RETURNS trigger AS $$
DECLARE owner legacy_treatment_agreements%ROWTYPE;
BEGIN
  SELECT * INTO owner FROM legacy_treatment_agreements WHERE id = NEW.agreement_id;
  IF owner.status <> 'live' THEN RETURN NEW; END IF;
  PERFORM id FROM patients WHERE id = owner.patient_id FOR NO KEY UPDATE;
  IF EXISTS (
    SELECT 1 FROM legacy_treatment_agreements a
      LEFT JOIN legacy_treatment_coverage_snapshots c ON c.agreement_id = a.id
    WHERE a.patient_id = owner.patient_id AND a.service_id = owner.service_id
      AND a.status = 'live' AND a.id <> owner.id
      AND (owner.document_id IS NOT NULL OR a.document_id IS NOT NULL)
      AND CASE
        WHEN c.agreement_id IS NULL THEN TRUE
        WHEN NEW.snapshot_scope IN ('both', 'full_mouth') OR c.snapshot_scope IN ('both', 'full_mouth') THEN TRUE
        WHEN NEW.snapshot_scope IS NOT NULL AND c.snapshot_scope IS NOT NULL THEN NEW.snapshot_scope = c.snapshot_scope
        WHEN NEW.snapshot_scope IN ('upper', 'lower') THEN EXISTS (
          SELECT 1 FROM unnest(c.snapshot_tooth_codes) tooth WHERE (tooth / 10 IN (1,2,5,6)) = (NEW.snapshot_scope = 'upper'))
        WHEN c.snapshot_scope IN ('upper', 'lower') THEN EXISTS (
          SELECT 1 FROM unnest(NEW.snapshot_tooth_codes) tooth WHERE (tooth / 10 IN (1,2,5,6)) = (c.snapshot_scope = 'upper'))
        ELSE NEW.snapshot_tooth_codes && c.snapshot_tooth_codes
      END
  ) THEN RAISE EXCEPTION 'historical document coverage overlaps an existing live agreement'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS legacy_treatment_document_coverage_overlap_guard ON legacy_treatment_coverage_snapshots;
CREATE CONSTRAINT TRIGGER legacy_treatment_document_coverage_overlap_guard
  AFTER INSERT ON legacy_treatment_coverage_snapshots DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION aqlan_legacy_document_coverage_overlap_guard();

CREATE TABLE IF NOT EXISTS legacy_treatment_document_revisions (
  id SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES legacy_treatment_documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  total_minor BIGINT NOT NULL CHECK (total_minor > 0 AND total_minor <= 9007199254740991),
  discount_minor BIGINT NOT NULL CHECK (discount_minor >= 0 AND discount_minor < total_minor),
  discount_reason TEXT,
  previously_paid_minor BIGINT NOT NULL CHECK (previously_paid_minor >= 0),
  remaining_minor BIGINT NOT NULL CHECK (remaining_minor = total_minor - discount_minor - previously_paid_minor AND remaining_minor >= 0),
  historical_as_of DATE NOT NULL CHECK (isfinite(historical_as_of)),
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  note TEXT,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  opening_history_id INTEGER REFERENCES patient_opening_balance_history(id),
  repayment_receipt JSONB,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_by TEXT NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(document_id, version),
  CHECK (discount_minor = 0 OR (discount_reason IS NOT NULL AND length(btrim(discount_reason)) BETWEEN 3 AND 300))
);

CREATE OR REPLACE FUNCTION aqlan_legacy_document_immutable() RETURNS trigger AS $$
DECLARE owner_patient INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'legacy_treatment_documents' THEN owner_patient := OLD.patient_id;
  ELSE SELECT patient_id INTO owner_patient FROM legacy_treatment_documents WHERE id = OLD.document_id;
  END IF;
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM patients WHERE id = owner_patient) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'historical documents and revisions are append-only';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER legacy_treatment_documents_immutable BEFORE UPDATE OR DELETE ON legacy_treatment_documents
  FOR EACH ROW EXECUTE FUNCTION aqlan_legacy_document_immutable();
CREATE OR REPLACE TRIGGER legacy_treatment_document_revisions_immutable BEFORE UPDATE OR DELETE ON legacy_treatment_document_revisions
  FOR EACH ROW EXECUTE FUNCTION aqlan_legacy_document_immutable();

CREATE OR REPLACE FUNCTION aqlan_legacy_document_line_guard() RETURNS trigger AS $$
DECLARE document legacy_treatment_documents%ROWTYPE;
BEGIN
  IF NEW.document_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO document FROM legacy_treatment_documents WHERE id = NEW.document_id FOR KEY SHARE;
  IF NOT FOUND OR NEW.patient_id <> document.patient_id OR NEW.currency <> document.currency
    OR NEW.document_line >= document.line_count THEN RAISE EXCEPTION 'historical line ownership mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM legacy_treatment_document_revisions WHERE document_id = document.id) THEN
    RAISE EXCEPTION 'historical document lines are sealed after the first revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER legacy_treatment_document_line_guard BEFORE INSERT ON legacy_treatment_agreements
  FOR EACH ROW EXECUTE FUNCTION aqlan_legacy_document_line_guard();

CREATE OR REPLACE FUNCTION aqlan_legacy_document_no_line_void() RETURNS trigger AS $$
BEGIN
  IF OLD.document_id IS NOT NULL THEN RAISE EXCEPTION 'historical document line requires document correction'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER legacy_treatment_document_no_line_void BEFORE UPDATE ON legacy_treatment_agreements
  FOR EACH ROW EXECUTE FUNCTION aqlan_legacy_document_no_line_void();

CREATE OR REPLACE FUNCTION aqlan_legacy_document_revision_guard() RETURNS trigger AS $$
DECLARE document legacy_treatment_documents%ROWTYPE; previous_version INTEGER; line JSONB; ordinal INTEGER := 0;
        agreement legacy_treatment_agreements%ROWTYPE; line_price NUMERIC; computed_total NUMERIC := 0; computed_discount NUMERIC := 0; line_discount NUMERIC; prior_lines JSONB;
BEGIN
  SELECT * INTO document FROM legacy_treatment_documents WHERE id = NEW.document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'historical document missing'; END IF;
  SELECT version, lines INTO previous_version, prior_lines FROM legacy_treatment_document_revisions WHERE document_id = document.id ORDER BY version DESC LIMIT 1;
  IF NEW.version <> COALESCE(previous_version,0)+1 OR jsonb_array_length(NEW.lines) <> document.line_count
    OR (SELECT count(*) FROM legacy_treatment_agreements WHERE document_id = document.id) <> document.line_count THEN
    RAISE EXCEPTION 'historical document revision or complete line count mismatch'; END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    SELECT * INTO agreement FROM legacy_treatment_agreements WHERE document_id = document.id AND document_line = ordinal;
    IF NOT FOUND OR jsonb_typeof(line) IS DISTINCT FROM 'object' OR agreement.status <> 'live'
      OR NOT (line ?& ARRAY['agreementId','planItemId','caseId','serviceId','toothCode','planId','doctorId','description','site','unitPriceMinor','discountMinor','netMinor'])
      OR jsonb_typeof(line->'site') IS DISTINCT FROM 'object'
      OR NOT (line->'site' ?& ARRAY['mode','toothCode','scope','surfaces','episodeTeeth'])
      OR (line->>'agreementId')::INTEGER IS DISTINCT FROM agreement.id
      OR (line->>'planItemId')::INTEGER IS DISTINCT FROM agreement.plan_item_id
      OR (line->>'caseId')::INTEGER IS DISTINCT FROM agreement.case_id
      OR (line->>'serviceId')::INTEGER IS DISTINCT FROM agreement.service_id
      OR (line->>'toothCode')::SMALLINT IS DISTINCT FROM agreement.tooth_code
      OR NOT EXISTS (SELECT 1 FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
         WHERE i.id = agreement.plan_item_id AND t.id = (line->>'planId')::INTEGER AND t.patient_id = document.patient_id
           AND t.base_currency = document.currency AND i.case_id IS NOT DISTINCT FROM agreement.case_id
           AND i.service_id = agreement.service_id AND i.tooth_code IS NOT DISTINCT FROM agreement.tooth_code
           AND i.doctor_id IS NOT DISTINCT FROM (line->>'doctorId')::INTEGER)
      OR NOT EXISTS (SELECT 1 FROM legacy_treatment_coverage_snapshots c WHERE c.agreement_id = agreement.id
         AND c.snapshot_mode = line->'site'->>'mode' AND c.anchor_tooth_code IS NOT DISTINCT FROM (line->'site'->>'toothCode')::SMALLINT
         AND c.snapshot_scope IS NOT DISTINCT FROM line->'site'->>'scope'
         AND c.snapshot_surfaces IS NOT DISTINCT FROM line->'site'->>'surfaces'
         AND c.snapshot_tooth_codes = CASE WHEN line->'site'->'episodeTeeth' <> 'null'::jsonb
           THEN ARRAY(SELECT jsonb_array_elements_text(line->'site'->'episodeTeeth')::SMALLINT)
           WHEN agreement.tooth_code IS NULL THEN '{}'::SMALLINT[] ELSE ARRAY[agreement.tooth_code] END)
      THEN RAISE EXCEPTION 'historical document clinical lineage mismatch'; END IF;
    IF previous_version IS NOT NULL AND (line - ARRAY['unitPriceMinor','discountMinor','netMinor']) IS DISTINCT FROM ((prior_lines->ordinal) - ARRAY['unitPriceMinor','discountMinor','netMinor']) THEN
      RAISE EXCEPTION 'historical financial correction cannot replace clinical identities';
    END IF;
    IF jsonb_typeof(line->'unitPriceMinor') IS DISTINCT FROM 'number' OR jsonb_typeof(line->'discountMinor') IS DISTINCT FROM 'number' OR jsonb_typeof(line->'netMinor') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'historical line amount invalid'; END IF;
    line_price := (line->>'unitPriceMinor')::NUMERIC;
    IF (previous_version IS NULL AND line_price <> agreement.agreed_minor) OR line_price <= 0 OR line_price <> trunc(line_price) OR line_price > 9007199254740991 THEN RAISE EXCEPTION 'historical line amount invalid'; END IF;
    line_discount := (line->>'discountMinor')::NUMERIC;
    IF line_discount < 0 OR line_discount > line_price OR line_discount <> trunc(line_discount)
      OR (line->>'netMinor')::NUMERIC IS DISTINCT FROM line_price-line_discount THEN RAISE EXCEPTION 'historical discount allocation invalid'; END IF;
    computed_discount := computed_discount + line_discount;
    computed_total := computed_total + line_price;
    ordinal := ordinal + 1;
  END LOOP;
  IF computed_total <> NEW.total_minor OR computed_discount <> NEW.discount_minor THEN RAISE EXCEPTION 'historical document total mismatch'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER legacy_treatment_document_revision_guard BEFORE INSERT ON legacy_treatment_document_revisions
  FOR EACH ROW EXECUTE FUNCTION aqlan_legacy_document_revision_guard();

-- A cleared opening bucket remains a real historical schedule target. Canonical
-- writers still require a current collectible target. Restore may use its audited
-- same-patient/currency opening history, never create a fictional opening row.
CREATE OR REPLACE FUNCTION aqlan_debt_repayment_guard() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'debt repayment history is append-only'; END IF;
  IF TG_TABLE_NAME = 'debt_repayment_arrangements' THEN
    IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM invoices WHERE id=NEW.invoice_id AND patient_id=NEW.patient_id AND base_currency=NEW.currency)
      THEN RAISE EXCEPTION 'debt repayment invoice ownership/currency mismatch'; END IF;
    IF NEW.opening_currency IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM patient_opening_balances WHERE patient_id=NEW.patient_id AND currency=NEW.currency)
      AND NOT EXISTS (SELECT 1 FROM patient_opening_balance_history h WHERE h.patient_id=NEW.patient_id AND h.currency=NEW.currency
        AND (h.before_amount_minor>0 OR h.after_amount_minor>0))
      THEN RAISE EXCEPTION 'debt repayment opening target missing'; END IF;
  ELSE
    PERFORM id FROM debt_repayment_arrangements WHERE id=NEW.arrangement_id FOR UPDATE;
    IF NEW.version <> COALESCE((SELECT MAX(version) FROM debt_repayment_revisions WHERE arrangement_id=NEW.arrangement_id),0)+1
      THEN RAISE EXCEPTION 'debt repayment revision is stale'; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

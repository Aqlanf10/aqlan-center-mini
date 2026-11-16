/** Unnumbered additive proposal, installed explicitly after supplier finance.
 * Keys are the existing server-computed supplierInvoiceDuplicateKey contract.
 * Never recompute Unicode case folding differently in PostgreSQL. */
export const INVENTORY_SUPPLIER_NUMBER_SQL = String.raw`
CREATE TABLE IF NOT EXISTS supplier_invoice_number_claims (
 duplicate_key TEXT PRIMARY KEY CHECK(length(duplicate_key) BETWEEN 1 AND 2048),
 invoice_id UUID NOT NULL UNIQUE REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
 first_version INTEGER NOT NULL CHECK(first_version>0),
 document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS supplier_invoice_number_claims_immutable ON supplier_invoice_number_claims;
CREATE TRIGGER supplier_invoice_number_claims_immutable BEFORE UPDATE OR DELETE ON supplier_invoice_number_claims FOR EACH ROW EXECUTE FUNCTION inventory_procurement_append_only();

-- One canonical read-only reconstruction projection; original wins adoption-v1 ties.
CREATE OR REPLACE VIEW inventory_supplier_number_sources AS
WITH evidence AS (
 SELECT duplicate_key,id AS invoice_id,(document->>'version')::integer AS version,document,created_by,created_at,0 AS priority FROM supplier_invoices WHERE duplicate_key IS NOT NULL
 UNION ALL
 SELECT match_plan->>'duplicateKey',invoice_id,version,document,created_by,created_at,1 AS priority FROM supplier_invoice_revisions WHERE match_plan->>'duplicateKey' IS NOT NULL
)
SELECT DISTINCT ON(invoice_id,duplicate_key) duplicate_key,invoice_id,version AS first_version,document,created_by,created_at
FROM evidence ORDER BY invoice_id,duplicate_key,version,priority;

-- Conflicting or drifting history aborts installation, rather than being discarded.
INSERT INTO supplier_invoice_number_claims(duplicate_key,invoice_id,first_version,document,created_by,created_at)
SELECT * FROM inventory_supplier_number_sources ON CONFLICT(duplicate_key) DO NOTHING;
DO $backfill$ BEGIN
 IF EXISTS((SELECT * FROM inventory_supplier_number_sources EXCEPT SELECT * FROM supplier_invoice_number_claims)
 UNION ALL (SELECT * FROM supplier_invoice_number_claims EXCEPT SELECT * FROM inventory_supplier_number_sources)) THEN
 RAISE EXCEPTION 'Conflicting historical supplier invoice number claims' USING ERRCODE='23505'; END IF;
END $backfill$;

CREATE OR REPLACE FUNCTION inventory_supplier_number_revision_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE prior_document JSONB; prior_match JSONB; BEGIN
 PERFORM 1 FROM supplier_invoices WHERE id=NEW.invoice_id FOR UPDATE;
 SELECT document,match_plan INTO prior_document,prior_match FROM supplier_invoice_revisions WHERE invoice_id=NEW.invoice_id ORDER BY version DESC LIMIT 1;
 IF NOT FOUND THEN SELECT document,match_plan INTO prior_document,prior_match FROM supplier_invoices WHERE id=NEW.invoice_id; END IF;
 IF left(NEW.document->>'invoiceDate',4) IS DISTINCT FROM left(prior_document->>'invoiceDate',4)
 OR (prior_document->>'invoiceNumber' IS NOT NULL AND NEW.match_plan->>'duplicateKey' IS DISTINCT FROM prior_match->>'duplicateKey')
 OR (prior_document->>'invoiceNumber' IS NULL AND NEW.document->>'invoiceNumber' IS NOT NULL AND NEW.document->>'missingNumberReason' IS NOT NULL) THEN
 RAISE EXCEPTION 'Invoice number completion must retain established source identity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS inventory_supplier_number_revision_guard ON supplier_invoice_revisions;
CREATE TRIGGER inventory_supplier_number_revision_guard BEFORE INSERT ON supplier_invoice_revisions FOR EACH ROW EXECUTE FUNCTION inventory_supplier_number_revision_guard();

CREATE OR REPLACE FUNCTION inventory_supplier_number_claim() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE source_id UUID; number_key TEXT; claimed UUID; BEGIN
 IF TG_TABLE_NAME='supplier_invoices' THEN source_id:=NEW.id; ELSE source_id:=NEW.invoice_id; END IF;
 number_key:=NEW.match_plan->>'duplicateKey';
 IF (NEW.document->>'invoiceNumber' IS NULL) IS DISTINCT FROM (number_key IS NULL) THEN
 RAISE EXCEPTION 'Invoice number and matched source claim must agree' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='supplier_invoices' THEN
 IF NEW.duplicate_key IS DISTINCT FROM number_key THEN RAISE EXCEPTION 'Original number claim mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF number_key IS NULL THEN RETURN NEW; END IF;
 INSERT INTO supplier_invoice_number_claims(duplicate_key,invoice_id,first_version,document,created_by,created_at)
 VALUES(number_key,source_id,(NEW.document->>'version')::integer,NEW.document,NEW.created_by,NEW.created_at) ON CONFLICT(duplicate_key) DO NOTHING;
 SELECT invoice_id INTO claimed FROM supplier_invoice_number_claims WHERE duplicate_key=number_key;
 IF claimed IS DISTINCT FROM source_id THEN RAISE EXCEPTION 'Supplier invoice number already belongs to another source' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS inventory_supplier_number_claim ON supplier_invoices;
CREATE TRIGGER inventory_supplier_number_claim AFTER INSERT ON supplier_invoices FOR EACH ROW EXECUTE FUNCTION inventory_supplier_number_claim();
DROP TRIGGER IF EXISTS inventory_supplier_number_claim ON supplier_invoice_revisions;
CREATE TRIGGER inventory_supplier_number_claim AFTER INSERT ON supplier_invoice_revisions FOR EACH ROW EXECUTE FUNCTION inventory_supplier_number_claim();

CREATE OR REPLACE FUNCTION inventory_supplier_number_claim_source_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inventory_supplier_number_sources s WHERE s.duplicate_key=NEW.duplicate_key AND s.invoice_id=NEW.invoice_id AND s.first_version=NEW.first_version AND s.document=NEW.document AND s.created_by=NEW.created_by AND s.created_at=NEW.created_at) THEN
 RAISE EXCEPTION 'Number claim requires its exact immutable invoice source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS inventory_supplier_number_claim_source_guard ON supplier_invoice_number_claims;
CREATE CONSTRAINT TRIGGER inventory_supplier_number_claim_source_guard AFTER INSERT ON supplier_invoice_number_claims DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_supplier_number_claim_source_guard();
`;

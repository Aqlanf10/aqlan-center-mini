/** Unnumbered additive proposal; never installed by runtime or normal migrations. */
export const INVENTORY_SUPPLIER_FINANCE_SQL = `
CREATE TABLE IF NOT EXISTS supplier_invoice_finance_roots (
 invoice_id UUID PRIMARY KEY REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
 realm_id TEXT NOT NULL CHECK(length(realm_id) BETWEEN 1 AND 240),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS supplier_invoice_revisions (
 invoice_id UUID NOT NULL REFERENCES supplier_invoice_finance_roots(invoice_id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>0),
 document JSONB NOT NULL CHECK(jsonb_typeof(document)='object'),
 match_plan JSONB NOT NULL CHECK(jsonb_typeof(match_plan)='object'),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 2000),
 created_by INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(invoice_id,version)
);
CREATE TABLE IF NOT EXISTS supplier_invoice_postings (
 invoice_id UUID PRIMARY KEY REFERENCES supplier_invoice_payable_links(invoice_id) ON DELETE RESTRICT,
 version INTEGER NOT NULL, digest TEXT NOT NULL CHECK(length(digest)=64),
 realm_id TEXT NOT NULL, subject_id TEXT NOT NULL,
 FOREIGN KEY(invoice_id,version) REFERENCES supplier_invoice_revisions(invoice_id,version)
);
CREATE TABLE IF NOT EXISTS supplier_invoice_cancellations (
 invoice_id UUID PRIMARY KEY REFERENCES supplier_invoice_postings(invoice_id),
 payable_id INTEGER NOT NULL UNIQUE REFERENCES payables(id),
 adjustment_id INTEGER NOT NULL UNIQUE REFERENCES payable_adjustments(id),
 currency TEXT NOT NULL CHECK(currency IN ('YER','SAR','USD')),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
 exchange_rate NUMERIC(18,6) NOT NULL CHECK(exchange_rate>0),
 base_amount_minor BIGINT NOT NULL CHECK(base_amount_minor>=0),
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 2000),
 created_by INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE VIEW inventory_effective_supplier_invoices AS
 SELECT i.id,i.order_id,COALESCE(r.document,i.document) AS document,
 COALESCE(r.match_plan,i.match_plan) AS match_plan,i.created_at
 FROM supplier_invoices i LEFT JOIN LATERAL
 (SELECT document,match_plan FROM supplier_invoice_revisions WHERE invoice_id=i.id ORDER BY version DESC LIMIT 1) r ON TRUE;
CREATE OR REPLACE VIEW inventory_effective_invoice_allocations AS
 SELECT i.id AS invoice_id,i.order_id,a.id,a.invoice_line_id,a.receipt_line_id,a.base_qty
 FROM supplier_invoices i JOIN supplier_invoice_receipt_allocations a ON a.invoice_id=i.id
 WHERE NOT EXISTS(SELECT 1 FROM supplier_invoice_revisions r WHERE r.invoice_id=i.id)
 UNION ALL
 SELECT i.id,i.order_id,a->>'id',l->>'id',a->>'receiptLineId',(a->>'baseQuantity')::numeric
 FROM inventory_effective_supplier_invoices i
 CROSS JOIN LATERAL jsonb_array_elements(i.document->'lines') l
 CROSS JOIN LATERAL jsonb_array_elements(l->'receiptAllocations') a
 WHERE i.match_plan->>'status'='matched'
 AND EXISTS(SELECT 1 FROM supplier_invoice_revisions r WHERE r.invoice_id=i.id);
DO $guards$ DECLARE rel TEXT; BEGIN
 FOREACH rel IN ARRAY ARRAY['supplier_invoice_finance_roots','supplier_invoice_revisions','supplier_invoice_postings','supplier_invoice_cancellations'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname=rel||'_immutable' AND tgrelid=to_regclass(rel)) THEN
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION inventory_procurement_append_only()',rel||'_immutable',rel);
 END IF; END LOOP;
END $guards$;
CREATE OR REPLACE FUNCTION inventory_linked_payable_immutable() RETURNS TRIGGER AS $guard$
BEGIN
 IF EXISTS(SELECT 1 FROM supplier_invoice_payable_links WHERE payable_id=OLD.id) THEN
 RAISE EXCEPTION 'Inventory-linked payable is immutable; use source-linked cancellation'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $guard$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS inventory_linked_payable_immutable ON payables;
CREATE TRIGGER inventory_linked_payable_immutable BEFORE UPDATE OR DELETE ON payables
 FOR EACH ROW EXECUTE FUNCTION inventory_linked_payable_immutable();
CREATE OR REPLACE FUNCTION inventory_invoice_posting_source_guard() RETURNS TRIGGER AS $guard$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM supplier_invoice_postings s
 JOIN supplier_invoice_finance_roots root ON root.invoice_id=s.invoice_id AND root.realm_id=s.realm_id
 JOIN supplier_invoice_revisions r ON r.invoice_id=s.invoice_id AND r.version=s.version
 JOIN supplier_invoices i ON i.id=s.invoice_id
 JOIN supplier_invoice_payable_links l ON l.invoice_id=s.invoice_id
 JOIN payables p ON p.id=l.payable_id
 WHERE s.invoice_id=NEW.invoice_id AND r.match_plan->>'status'='matched'
 AND p.party_id=i.supplier_party_id AND p.source_type='operational' AND p.lab_order_id IS NULL
 AND p.currency=r.document->>'currency' AND p.base_currency='YER'
 AND p.amount_minor=(r.match_plan->'total'->>'amountMinor')::bigint AND p.amount_minor>0
 AND p.amount_minor=(r.document->'valuation'->>'amountMinor')::bigint
 AND p.exchange_rate=(r.document->'valuation'->>'rateToBase')::numeric
 AND p.base_amount_minor=(r.document->'valuation'->>'baseAmountMinor')::bigint
 AND NOT EXISTS(SELECT 1 FROM supplier_invoice_revisions later WHERE later.invoice_id=r.invoice_id AND later.version>r.version)) THEN
 RAISE EXCEPTION 'Inventory payable requires exact immutable approved invoice source'; END IF;
 RETURN NEW;
END $guard$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS inventory_invoice_posting_source_guard ON supplier_invoice_postings;
CREATE CONSTRAINT TRIGGER inventory_invoice_posting_source_guard AFTER INSERT ON supplier_invoice_postings
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_invoice_posting_source_guard();
DROP TRIGGER IF EXISTS inventory_invoice_link_source_guard ON supplier_invoice_payable_links;
CREATE CONSTRAINT TRIGGER inventory_invoice_link_source_guard AFTER INSERT ON supplier_invoice_payable_links
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_invoice_posting_source_guard();
CREATE OR REPLACE FUNCTION inventory_invoice_revision_guard() RETURNS TRIGGER AS $guard$
DECLARE original JSONB; latest INTEGER; BEGIN
 SELECT document INTO original FROM supplier_invoices WHERE id=NEW.invoice_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM supplier_invoice_payable_links WHERE invoice_id=NEW.invoice_id) THEN
 RAISE EXCEPTION 'Posted invoice cannot acquire another revision'; END IF;
 SELECT COALESCE(MAX(version),0) INTO latest FROM supplier_invoice_revisions WHERE invoice_id=NEW.invoice_id;
 IF NEW.version<>latest+1 OR (NEW.document->>'version')::integer<>NEW.version
 OR NEW.document->>'id' IS DISTINCT FROM original->>'id'
 OR NEW.document->>'orderId' IS DISTINCT FROM original->>'orderId'
 OR NEW.document->>'supplierPartyId' IS DISTINCT FROM original->>'supplierPartyId'
 OR NEW.document->>'currency' IS DISTINCT FROM original->>'currency'
 OR NEW.document->>'branchId' IS DISTINCT FROM original->>'branchId' THEN
 RAISE EXCEPTION 'Invoice revision requires immutable identity and sequential version'; END IF;
 RETURN NEW;
END $guard$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS inventory_invoice_revision_guard ON supplier_invoice_revisions;
CREATE TRIGGER inventory_invoice_revision_guard BEFORE INSERT ON supplier_invoice_revisions
 FOR EACH ROW EXECUTE FUNCTION inventory_invoice_revision_guard();
CREATE OR REPLACE FUNCTION inventory_invoice_adjustment_source_guard() RETURNS TRIGGER AS $guard$
DECLARE adjustment INTEGER; BEGIN
 IF TG_TABLE_NAME='payable_adjustments' THEN
 IF NOT EXISTS(SELECT 1 FROM supplier_invoice_payable_links WHERE payable_id=NEW.payable_id) THEN RETURN NEW; END IF;
 adjustment:=NEW.id;
 ELSE adjustment:=NEW.adjustment_id; END IF;
 IF NOT EXISTS(SELECT 1 FROM supplier_invoice_cancellations c
 JOIN supplier_invoice_payable_links l ON l.invoice_id=c.invoice_id AND l.payable_id=c.payable_id
 JOIN supplier_invoice_postings s ON s.invoice_id=c.invoice_id
 JOIN payables p ON p.id=c.payable_id
 JOIN payable_adjustments a ON a.id=c.adjustment_id AND a.payable_id=p.id
 WHERE a.id=adjustment AND p.source_type='operational' AND p.lab_order_id IS NULL
 AND a.delta_minor=-p.amount_minor AND c.amount_minor=p.amount_minor
 AND c.currency=p.currency AND c.exchange_rate=p.exchange_rate AND c.base_amount_minor=p.base_amount_minor
 AND a.reason=c.reason
 AND NOT EXISTS(SELECT 1 FROM payable_adjustments extra WHERE extra.payable_id=p.id AND extra.id<>a.id)) THEN
 RAISE EXCEPTION 'Inventory adjustment requires exact immutable invoice cancellation source'; END IF;
 RETURN NEW;
END $guard$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS inventory_invoice_adjustment_source_guard ON payable_adjustments;
CREATE CONSTRAINT TRIGGER inventory_invoice_adjustment_source_guard AFTER INSERT ON payable_adjustments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_invoice_adjustment_source_guard();
DROP TRIGGER IF EXISTS inventory_invoice_cancellation_source_guard ON supplier_invoice_cancellations;
CREATE CONSTRAINT TRIGGER inventory_invoice_cancellation_source_guard AFTER INSERT ON supplier_invoice_cancellations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory_invoice_adjustment_source_guard();
`;

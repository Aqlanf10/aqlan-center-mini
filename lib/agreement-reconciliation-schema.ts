/** Exact reviewed 0078 DDL. Kept byte-identical to its migration by regression. */
export const AGREEMENT_RECONCILIATION_SQL = String.raw`-- PROPOSED 0078 ONLY. Root reserved; collision review 2026-10-25 23:32.
-- Independent review/restore/registration gates remain required before deployment.
-- No backfill, no rewrite of prior invoices/receipts/commission history.
CREATE TABLE agreement_reconciliations (
 id BIGSERIAL PRIMARY KEY,
 plan_id INTEGER NOT NULL UNIQUE REFERENCES treatment_plans(id),
 patient_id INTEGER NOT NULL REFERENCES patients(id),
 actor_id INTEGER NOT NULL REFERENCES users(id),
 operation_key TEXT NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
 request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 expected_source_hash TEXT NOT NULL CHECK (expected_source_hash ~ '^[a-f0-9]{64}$'),
 currency TEXT NOT NULL CHECK (currency IN ('YER','SAR','USD')),
 agreed_minor BIGINT NOT NULL CHECK (agreed_minor BETWEEN 1 AND 9007199254740991),
 billed_principal_minor BIGINT NOT NULL CHECK (billed_principal_minor BETWEEN 0 AND 9007199254740991),
 unbilled_principal_minor BIGINT NOT NULL CHECK (unbilled_principal_minor BETWEEN 0 AND 9007199254740991),
 delta_invoice_id INTEGER UNIQUE REFERENCES invoices(id),
 doctor_id INTEGER REFERENCES parties(id),
 source_snapshot JSONB NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
 receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt)='object'),
 reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,operation_key),
 CHECK (agreed_minor = billed_principal_minor + unbilled_principal_minor),
 CHECK ((unbilled_principal_minor=0 AND delta_invoice_id IS NULL) OR (unbilled_principal_minor>0 AND delta_invoice_id IS NOT NULL AND doctor_id IS NOT NULL))
);
CREATE TABLE agreement_reconciliation_sources (
 reconciliation_id BIGINT NOT NULL REFERENCES agreement_reconciliations(id),
 invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id),
 principal_minor BIGINT NOT NULL CHECK (principal_minor BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(reconciliation_id,invoice_id)
);
CREATE TABLE agreement_reconciliation_rejections (
 actor_id INTEGER NOT NULL REFERENCES users(id), operation_key TEXT NOT NULL,
 plan_id INTEGER NOT NULL REFERENCES treatment_plans(id), patient_id INTEGER NOT NULL REFERENCES patients(id),
 request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 expected_source_hash TEXT NOT NULL CHECK (expected_source_hash ~ '^[a-f0-9]{64}$'),
 observed_source_hash TEXT NOT NULL CHECK (observed_source_hash ~ '^[a-f0-9]{64}$'),
 rejected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,operation_key)
);
-- The following guards preserve command identities, source ownership and
-- principal completeness. This file remains a proposal, not a registered migration.

CREATE FUNCTION aqlan_reconciliation_immutable() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE has_rows BOOLEAN;
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'reconciliation reset requires READ COMMITTED'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I)',TG_TABLE_SCHEMA,TG_TABLE_NAME) INTO has_rows;
  IF has_rows THEN RAISE EXCEPTION 'reconciliation identities cannot be truncated'; END IF;
  RETURN NULL;
 END IF;
 RAISE EXCEPTION 'reconciliation history is immutable';
END $$;
CREATE TRIGGER reconciliation_immutable BEFORE UPDATE OR DELETE ON agreement_reconciliations FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_immutable();
CREATE TRIGGER reconciliation_sources_immutable BEFORE UPDATE OR DELETE ON agreement_reconciliation_sources FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_immutable();
CREATE TRIGGER reconciliation_rejections_immutable BEFORE UPDATE OR DELETE ON agreement_reconciliation_rejections FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_immutable();
CREATE TRIGGER reconciliation_truncate BEFORE TRUNCATE ON agreement_reconciliations FOR EACH STATEMENT EXECUTE FUNCTION aqlan_reconciliation_immutable();
CREATE TRIGGER reconciliation_sources_truncate BEFORE TRUNCATE ON agreement_reconciliation_sources FOR EACH STATEMENT EXECUTE FUNCTION aqlan_reconciliation_immutable();
CREATE TRIGGER reconciliation_rejections_truncate BEFORE TRUNCATE ON agreement_reconciliation_rejections FOR EACH STATEMENT EXECUTE FUNCTION aqlan_reconciliation_immutable();

CREATE FUNCTION aqlan_reconciliation_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE protected BOOLEAN;
BEGIN
 IF TG_TABLE_NAME='invoices' THEN
  IF TG_OP='INSERT' THEN
   IF EXISTS(SELECT 1 FROM agreement_reconciliations WHERE plan_id=NEW.plan_id) THEN RAISE EXCEPTION 'reconciled agreement cannot issue classic principal'; END IF;
   RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM agreement_reconciliations r WHERE r.plan_id=NEW.plan_id
    AND NOT EXISTS(SELECT 1 FROM agreement_reconciliation_sources s WHERE s.reconciliation_id=r.id AND s.invoice_id=OLD.id)) THEN
   RAISE EXCEPTION 'reconciled agreement cannot adopt an unrelated invoice by update';
  END IF;
  protected := EXISTS(SELECT 1 FROM agreement_reconciliation_sources WHERE invoice_id=OLD.id);
  IF protected AND (TG_OP='DELETE' OR (NEW.patient_id,NEW.plan_id,NEW.base_currency,NEW.total_minor,NEW.discount_minor,NEW.created_at)
    IS DISTINCT FROM (OLD.patient_id,OLD.plan_id,OLD.base_currency,OLD.total_minor,OLD.discount_minor,OLD.created_at)
    OR NEW.status='cancelled') THEN RAISE EXCEPTION 'reconciled source requires explicit financial review'; END IF;
 ELSIF TG_TABLE_NAME='treatment_plans' THEN
  protected := EXISTS(SELECT 1 FROM agreement_reconciliations WHERE plan_id=OLD.id);
  IF protected AND (TG_OP='DELETE' OR (NEW.patient_id,NEW.total_minor,NEW.base_currency,NEW.primary_doctor_id,NEW.billing_mode,NEW.total_from_items)
    IS DISTINCT FROM (OLD.patient_id,OLD.total_minor,OLD.base_currency,OLD.primary_doctor_id,OLD.billing_mode,OLD.total_from_items)
    OR NEW.status='cancelled') THEN RAISE EXCEPTION 'reconciled terms require explicit financial review'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_invoice_guard BEFORE INSERT OR UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_source_guard();
CREATE TRIGGER reconciliation_plan_guard BEFORE UPDATE OR DELETE ON treatment_plans FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_source_guard();

CREATE FUNCTION aqlan_reconciliation_membership_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agreement_reconciliations r JOIN invoices i ON i.id=NEW.invoice_id
  WHERE r.id=NEW.reconciliation_id AND i.patient_id=r.patient_id AND i.plan_id=r.plan_id
    AND i.base_currency=r.currency AND i.status<>'cancelled'
    AND i.total_minor-i.discount_minor=NEW.principal_minor) THEN
  RAISE EXCEPTION 'reconciliation source membership mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_membership_guard BEFORE INSERT ON agreement_reconciliation_sources FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_membership_guard();
-- Deferred source completeness and the cross-table attempt fence are verified
-- separately from the application-level exact-command replay contract.
CREATE FUNCTION aqlan_reconciliation_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_owner INTEGER; new_owner INTEGER;
BEGIN
 IF TG_TABLE_NAME='invoice_items' THEN
  old_owner := CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.invoice_id END;
  new_owner := CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.invoice_id END;
  IF EXISTS(SELECT 1 FROM agreement_reconciliation_sources WHERE invoice_id IN(old_owner,new_owner)) THEN RAISE EXCEPTION 'reconciled invoice items are immutable'; END IF;
 ELSE
  old_owner := CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.plan_id END;
  new_owner := CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.plan_id END;
  IF EXISTS(SELECT 1 FROM agreement_reconciliations WHERE plan_id IN(old_owner,new_owner)) THEN RAISE EXCEPTION 'reconciled schedule requires financial review'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_items_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_items FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_terms_guard();
CREATE TRIGGER reconciliation_schedule_guard BEFORE INSERT OR UPDATE OR DELETE ON plan_installments FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_terms_guard();

CREATE FUNCTION aqlan_reconciliation_complete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_row agreement_reconciliations%ROWTYPE; recorded NUMERIC; target_id BIGINT;
BEGIN
 IF TG_TABLE_NAME='agreement_reconciliations' THEN target_id:=NEW.id; ELSE target_id:=NEW.reconciliation_id; END IF;
 SELECT * INTO event_row FROM agreement_reconciliations WHERE id=target_id;
 IF NOT EXISTS(SELECT 1 FROM treatment_plans p WHERE p.id=event_row.plan_id AND p.patient_id=event_row.patient_id
   AND p.total_minor=event_row.agreed_minor AND p.base_currency=event_row.currency AND p.status IN('active','completed')) THEN
   RAISE EXCEPTION 'reconciliation plan identity mismatch';
 END IF;
 IF EXISTS(SELECT 1 FROM plan_items i WHERE i.plan_id=event_row.plan_id AND
   (i.billed_invoice_id IS NOT NULL OR i.origin_invoice_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM invoice_items x WHERE x.plan_item_id=i.id OR (x.source_type='plan_item' AND x.source_id=i.id))
    OR EXISTS(SELECT 1 FROM legacy_treatment_agreements a WHERE a.plan_item_id=i.id))) THEN
   RAISE EXCEPTION 'reconciliation has mixed plan item financial lineage';
 END IF;
 SELECT COALESCE(sum(principal_minor),0) INTO recorded FROM agreement_reconciliation_sources WHERE reconciliation_id=event_row.id;
 IF recorded<>event_row.agreed_minor THEN RAISE EXCEPTION 'reconciliation sources do not equal agreed principal'; END IF;
 IF EXISTS(SELECT 1 FROM invoices i WHERE i.plan_id=event_row.plan_id AND NOT EXISTS(
   SELECT 1 FROM agreement_reconciliation_sources s WHERE s.reconciliation_id=event_row.id AND s.invoice_id=i.id)) THEN
   RAISE EXCEPTION 'reconciliation omits a plan invoice';
 END IF;
 IF event_row.delta_invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agreement_reconciliation_sources
   WHERE reconciliation_id=event_row.id AND invoice_id=event_row.delta_invoice_id AND principal_minor=event_row.unbilled_principal_minor) THEN
   RAISE EXCEPTION 'reconciliation delta identity mismatch';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reconciliation_complete_guard AFTER INSERT ON agreement_reconciliations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_complete_guard();

CREATE FUNCTION aqlan_reconciliation_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM treatment_plans WHERE id=NEW.plan_id AND patient_id=NEW.patient_id) THEN RAISE EXCEPTION 'reconciliation attempt patient mismatch'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('aqlan:agreement-reconcile:'||NEW.actor_id::text||':'||NEW.operation_key,0));
 IF TG_TABLE_NAME='agreement_reconciliations' THEN
  IF EXISTS(SELECT 1 FROM agreement_reconciliation_rejections WHERE actor_id=NEW.actor_id AND operation_key=NEW.operation_key) THEN RAISE EXCEPTION 'reconciliation attempt permanently rejected'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM agreement_reconciliations WHERE actor_id=NEW.actor_id AND operation_key=NEW.operation_key) THEN RAISE EXCEPTION 'reconciliation attempt already committed'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_attempt_guard BEFORE INSERT ON agreement_reconciliations FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_attempt_guard();
CREATE TRIGGER reconciliation_rejected_attempt_guard BEFORE INSERT ON agreement_reconciliation_rejections FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_attempt_guard();

CREATE CONSTRAINT TRIGGER reconciliation_member_complete_guard AFTER INSERT ON agreement_reconciliation_sources
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_complete_guard();

CREATE FUNCTION aqlan_reconciliation_lineage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_plan INTEGER;
BEGIN
 IF TG_TABLE_NAME='invoice_items' THEN
  IF EXISTS(SELECT 1 FROM plan_items i JOIN agreement_reconciliations r ON r.plan_id=i.plan_id
    WHERE i.id IN(NEW.plan_item_id,CASE WHEN NEW.source_type='plan_item' THEN NEW.source_id END)
      AND NOT EXISTS(SELECT 1 FROM agreement_reconciliation_sources s
        WHERE s.reconciliation_id=r.id AND s.invoice_id=NEW.invoice_id)) THEN
   RAISE EXCEPTION 'reconciled plan cannot acquire another invoice item source';
  END IF;
 ELSIF TG_TABLE_NAME='plan_items' THEN
  IF TG_OP='UPDATE' THEN old_plan:=OLD.plan_id; END IF;
  IF EXISTS(SELECT 1 FROM agreement_reconciliations WHERE plan_id IN(NEW.plan_id,old_plan))
    AND (NEW.billed_invoice_id IS NOT NULL OR NEW.origin_invoice_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM invoice_items x WHERE x.plan_item_id=NEW.id OR (x.source_type='plan_item' AND x.source_id=NEW.id))
      OR EXISTS(SELECT 1 FROM legacy_treatment_agreements a WHERE a.plan_item_id=NEW.id)) THEN
   RAISE EXCEPTION 'reconciled plan item cannot acquire financial lineage';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM plan_items i JOIN agreement_reconciliations r ON r.plan_id=i.plan_id WHERE i.id=NEW.plan_item_id) THEN
   RAISE EXCEPTION 'reconciled plan cannot acquire historical principal';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconciliation_item_lineage_guard BEFORE INSERT OR UPDATE ON invoice_items FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_lineage_guard();
CREATE TRIGGER reconciliation_plan_item_lineage_guard BEFORE INSERT OR UPDATE ON plan_items FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_lineage_guard();
CREATE TRIGGER reconciliation_legacy_lineage_guard BEFORE INSERT OR UPDATE ON legacy_treatment_agreements FOR EACH ROW EXECUTE FUNCTION aqlan_reconciliation_lineage_guard();
`;

-- 0066: append-only, explicitly source-linked agreement upgrade; no backfill.
-- A delta invoice is a difference-only receivable. Original invoice and cash are never rewritten.
CREATE TABLE agreement_delta_amendments (
  id BIGSERIAL PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE RESTRICT,
  plan_item_id INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  case_id INTEGER REFERENCES clinical_cases(id) ON DELETE RESTRICT,
  original_invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  delta_invoice_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  previous_amendment_id BIGINT REFERENCES agreement_delta_amendments(id) ON DELETE RESTRICT,
  old_service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  new_service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  doctor_id INTEGER REFERENCES parties(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  old_unit_minor BIGINT NOT NULL CHECK (old_unit_minor >= 0),
  new_unit_minor BIGINT NOT NULL CHECK (new_unit_minor >= 0),
  previous_agreement_minor BIGINT NOT NULL CHECK (previous_agreement_minor > 0),
  delta_minor BIGINT NOT NULL CHECK (delta_minor > 0),
  revised_agreement_minor BIGINT NOT NULL CHECK (revised_agreement_minor=previous_agreement_minor+delta_minor),
  settled_snapshot_minor BIGINT NOT NULL CHECK (settled_snapshot_minor >= 0),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_username TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT amendment_positive_delta CHECK (delta_minor=(new_unit_minor-old_unit_minor)*quantity)
);
CREATE INDEX agreement_delta_amendments_plan_time_idx ON agreement_delta_amendments(plan_id,occurred_at,id);
CREATE INDEX agreement_delta_amendments_patient_time_idx ON agreement_delta_amendments(patient_id,occurred_at,id);
CREATE UNIQUE INDEX agreement_delta_amendments_next_unique
  ON agreement_delta_amendments(previous_amendment_id) WHERE previous_amendment_id IS NOT NULL;
CREATE FUNCTION aqlan_agreement_delta_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'agreement amendment events are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER agreement_delta_immutable BEFORE UPDATE OR DELETE ON agreement_delta_amendments
  FOR EACH ROW EXECUTE FUNCTION aqlan_agreement_delta_immutable();
CREATE TRIGGER agreement_delta_no_truncate BEFORE TRUNCATE ON agreement_delta_amendments
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_agreement_delta_immutable();
CREATE TABLE agreement_delta_attempt_rejections (
  idempotency_key TEXT PRIMARY KEY CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  expected_source_hash TEXT NOT NULL CHECK(expected_source_hash ~ '^[a-f0-9]{64}$'),
  observed_source_hash TEXT NOT NULL CHECK(observed_source_hash ~ '^[a-f0-9]{64}$'),
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER agreement_delta_attempt_rejections_immutable BEFORE UPDATE OR DELETE
 ON agreement_delta_attempt_rejections FOR EACH ROW EXECUTE FUNCTION aqlan_agreement_delta_immutable();
CREATE TRIGGER agreement_delta_attempt_rejections_no_truncate BEFORE TRUNCATE
 ON agreement_delta_attempt_rejections FOR EACH STATEMENT EXECUTE FUNCTION aqlan_agreement_delta_immutable();

-- No second billing of the already-covered plan item, including stale drafts.
-- One logical collection can fund the original invoice and one or more deltas.
-- Its receipt is immutable and committed with ALL individual payment receipts.
CREATE TABLE agreement_delta_collection_receipts (
  idempotency_key TEXT PRIMARY KEY CHECK(idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id INTEGER NOT NULL REFERENCES treatment_plans(id) ON DELETE RESTRICT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  payment_ids INTEGER[] NOT NULL CHECK(cardinality(payment_ids)>0),
  result_snapshot JSONB NOT NULL CHECK(jsonb_typeof(result_snapshot)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER agreement_delta_collection_immutable BEFORE UPDATE OR DELETE
  ON agreement_delta_collection_receipts FOR EACH ROW
  EXECUTE FUNCTION aqlan_agreement_delta_immutable();
CREATE TRIGGER agreement_delta_collection_no_truncate BEFORE TRUNCATE
  ON agreement_delta_collection_receipts FOR EACH STATEMENT
  EXECUTE FUNCTION aqlan_agreement_delta_immutable();
CREATE FUNCTION aqlan_agreement_delta_invoice_fence() RETURNS TRIGGER AS $$
DECLARE source_plan INTEGER;
BEGIN
  -- PostgreSQL PL/pgSQL does not type-narrow OLD from an AND predicate:
  -- invoices have id, but NOT invoice_id. Branch by table first.
  IF TG_TABLE_NAME='invoice_items' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.plan_item_id IS NOT NULL THEN
        SELECT pi.plan_id INTO source_plan FROM plan_items pi WHERE pi.id=NEW.plan_item_id;
      ELSIF NEW.source_type='plan_item' AND NEW.source_id IS NOT NULL THEN
        SELECT pi.plan_id INTO source_plan FROM plan_items pi WHERE pi.id=NEW.source_id;
      ELSE
        RETURN NEW;
      END IF;
      IF EXISTS(SELECT 1 FROM agreement_delta_amendments e
          WHERE e.plan_id=source_plan
          AND e.plan_item_id=COALESCE(NEW.plan_item_id,NEW.source_id)) THEN
        RAISE EXCEPTION 'amended plan work already financed; no second full billing';
      END IF;
      RETURN NEW;
    END IF;
    IF EXISTS(SELECT 1 FROM agreement_delta_amendments e WHERE e.delta_invoice_id=OLD.invoice_id) THEN
      RAISE EXCEPTION 'agreement delta invoice items are immutable';
    END IF;
  ELSIF TG_TABLE_NAME='invoices' THEN
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    IF EXISTS(SELECT 1 FROM agreement_delta_amendments e WHERE e.delta_invoice_id=OLD.id) THEN
      IF TG_OP='UPDATE' THEN
        -- Allow collection/refund status without touching value or ownership.
        IF (NEW.patient_id,NEW.base_currency,NEW.total_minor,NEW.discount_minor,
            NEW.plan_id,NEW.created_at,NEW.invoice_number)
           IS NOT DISTINCT FROM
           (OLD.patient_id,OLD.base_currency,OLD.total_minor,OLD.discount_minor,
            OLD.plan_id,OLD.created_at,OLD.invoice_number)
           AND NEW.status IN ('open','paid') THEN RETURN NEW; END IF;
      END IF;
      RAISE EXCEPTION 'agreement delta receivable is immutable';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER agreement_delta_item_fence BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION aqlan_agreement_delta_invoice_fence();
CREATE TRIGGER agreement_delta_invoice_fence BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION aqlan_agreement_delta_invoice_fence();

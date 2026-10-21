import { documentNumberSql } from "./document-numbers";

/** Unregistered candidate; never import from runtime ensureSchema yet. */
export const INVOICE_UNPAID_CURRENCY_SQL = `-- PROPOSED, UNREGISTERED U0 schema. Do not activate without the matching
-- application writer, readers, recovery contract and reviewed runtime manifest.
-- Source/target issuance is DB-owned; no caller-supplied existing target accepted.
ALTER TABLE invoice_corrections ADD COLUMN currency_evidence_kind TEXT NOT NULL
  DEFAULT 'legacy_v1' CHECK(currency_evidence_kind IN ('legacy_v1','unpaid_root_v1'));

CREATE TABLE invoice_unpaid_currency_claims (
  source_id INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
  target_currency TEXT NOT NULL CHECK(target_currency IN ('YER','SAR','USD')),
  intent JSONB NOT NULL,
  source_snapshot JSONB NOT NULL,
  item_snapshot JSONB NOT NULL,
  action_at TIMESTAMPTZ NOT NULL,
  transaction_id XID8 NOT NULL,
  created_by TEXT NOT NULL CHECK(length(btrim(created_by)) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 300),
  target_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  target_snapshot JSONB NOT NULL,
  target_items JSONB NOT NULL,
  item_pairs JSONB NOT NULL
);
CREATE TABLE invoice_unpaid_currency_transitions (
  correction_id INTEGER PRIMARY KEY REFERENCES invoice_corrections(id) ON DELETE RESTRICT,
  source_id INTEGER NOT NULL UNIQUE REFERENCES invoice_unpaid_currency_claims(source_id) ON DELETE RESTRICT,
  target_id INTEGER NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  target_snapshot JSONB NOT NULL,
  target_items JSONB NOT NULL
);

CREATE FUNCTION u0_assert_empty(root INTEGER) RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp VOLATILE AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM payments WHERE invoice_id=root)
    OR EXISTS(SELECT 1 FROM invoices WHERE id=root AND plan_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=root AND
      (plan_item_id IS NOT NULL OR source_type IS NOT NULL OR source_id IS NOT NULL))
    OR EXISTS(SELECT 1 FROM plan_items WHERE origin_invoice_id=root OR billed_invoice_id=root)
    OR EXISTS(SELECT 1 FROM clinical_cases WHERE origin_invoice_id=root)
    OR EXISTS(SELECT 1 FROM visits WHERE invoice_id=root)
    OR EXISTS(SELECT 1 FROM ortho_adjustments WHERE billing_invoice_id=root)
    OR EXISTS(SELECT 1 FROM approved_agreement_principals WHERE invoice_id=root)
    OR EXISTS(SELECT 1 FROM debt_repayment_arrangements WHERE invoice_id=root)
    THEN RAISE EXCEPTION 'U0 source is not standalone and receipt-free'; END IF;
END $$;

CREATE FUNCTION u0_claim_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp VOLATILE SET timezone='UTC' AS $$
DECLARE source invoices%ROWTYPE; target invoices%ROWTYPE; item invoice_items%ROWTYPE;
  requested JSONB; price NUMERIC; total NUMERIC:=0; discount NUMERIC;
  source_scale NUMERIC; target_scale NUMERIC; inserted_id INTEGER;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'U0 claim is immutable'; END IF;
  -- A KEY SHARE relation writer does not change the invoice tuple. An earlier
  -- RR snapshot could therefore miss its committed relation after waiting.
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'U0 root claim requires READ COMMITTED'; END IF;
  -- A caller cannot inject snapshots/times. Lock first, then use fresh statements.
  PERFORM id FROM invoices WHERE id=NEW.source_id FOR UPDATE;
  SELECT * INTO source FROM invoices WHERE id=NEW.source_id;
  IF source.id IS NULL OR source.status<>'open' OR source.base_currency NOT IN ('YER','SAR','USD')
    OR source.base_currency=NEW.target_currency
    OR source.note IS NOT NULL AND source.note ~* '(replac|correct|تصحيح|بديل)'
    OR EXISTS(SELECT 1 FROM invoice_corrections WHERE original_invoice_id=source.id OR corrected_invoice_id=source.id)
    OR EXISTS(SELECT 1 FROM invoice_settlement_reclassifications WHERE source.id=ANY(source_invoice_ids))
    THEN RAISE EXCEPTION 'U0 requires one live verified root'; END IF;
  PERFORM u0_assert_empty(source.id);
  IF jsonb_typeof(NEW.intent) IS DISTINCT FROM 'object'
    OR NEW.intent->>'mode' IS NULL OR NEW.intent->>'mode' NOT IN ('preserve-numerals','reviewed-target-amounts')
    OR jsonb_typeof(NEW.intent->'lines') IS DISTINCT FROM 'array'
    OR COALESCE(NEW.intent->>'discountMinor','') !~ '^[0-9]+$'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.intent->'lines') e WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
      OR COALESCE(e->>'itemId','') !~ '^[1-9][0-9]*$' OR COALESCE(e->>'unitPriceMinor','') !~ '^[0-9]+$')
    THEN RAISE EXCEPTION 'U0 explicit intent missing'; END IF;
  NEW.source_snapshot:=to_jsonb(source);
  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY id),'[]') INTO NEW.item_snapshot FROM invoice_items i WHERE invoice_id=source.id;
  IF jsonb_array_length(NEW.item_snapshot)=0 THEN RAISE EXCEPTION 'U0 source items missing'; END IF;
  IF source.total_minor NOT BETWEEN 0 AND 9007199254740991 OR source.discount_minor NOT BETWEEN 0 AND source.total_minor
    OR source.total_minor<>(SELECT sum(total_minor) FROM invoice_items WHERE invoice_id=source.id)
    OR EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=source.id AND (quantity<=0 OR unit_price_minor<0
      OR total_minor::NUMERIC<>unit_price_minor::NUMERIC*quantity)) THEN RAISE EXCEPTION 'U0 source amounts inconsistent'; END IF;
  -- Intent is an exact minor-unit instruction, never an exchange rate. Reject
  -- mixed/extra keys and duplicate/omitted source IDs before issuing anything.
  IF NEW.intent - ARRAY['mode','lines','discountMinor'] <> '{}'::jsonb
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.intent->'lines') e
      WHERE e - ARRAY['itemId','unitPriceMinor'] <> '{}'::jsonb)
    OR (SELECT array_agg((e->>'itemId')::INTEGER ORDER BY (e->>'itemId')::INTEGER)
      FROM jsonb_array_elements(NEW.intent->'lines') e)
      IS DISTINCT FROM (SELECT array_agg(id ORDER BY id) FROM invoice_items WHERE invoice_id=source.id)
    THEN RAISE EXCEPTION 'U0 exact explicit intent membership required'; END IF;
  source_scale:=CASE WHEN source.base_currency='YER' THEN 1 ELSE 100 END;
  target_scale:=CASE WHEN NEW.target_currency='YER' THEN 1 ELSE 100 END;
  discount:=(NEW.intent->>'discountMinor')::NUMERIC;
  FOR item IN SELECT * FROM invoice_items WHERE invoice_id=source.id ORDER BY id LOOP
    SELECT e INTO requested FROM jsonb_array_elements(NEW.intent->'lines') e WHERE (e->>'itemId')::INTEGER=item.id;
    price:=(requested->>'unitPriceMinor')::NUMERIC;
    IF price NOT BETWEEN 0 AND 9007199254740991
      OR NEW.intent->>'mode'='preserve-numerals' AND price<>item.unit_price_minor::NUMERIC*target_scale/source_scale
      THEN RAISE EXCEPTION 'U0 amount precision or range mismatch'; END IF;
    total:=total+price*item.quantity;
  END LOOP;
  IF total>9007199254740991 OR discount NOT BETWEEN 0 AND total
    OR NEW.intent->>'mode'='preserve-numerals' AND discount<>source.discount_minor::NUMERIC*target_scale/source_scale
    THEN RAISE EXCEPTION 'U0 total or discount mismatch'; END IF;
  NEW.action_at:=clock_timestamp(); NEW.transaction_id:=pg_current_xact_id();
  -- These INSERTs are the only source of target identity. All supplied target
  -- fields are overwritten; timestamps never purport to prove fresh creation.
  INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,note,created_by,created_at)
    VALUES(${documentNumberSql("invoice")},source.patient_id,total::BIGINT,discount::BIGINT,NEW.target_currency,
      'تصحيح للفاتورة '||source.invoice_number||' — '||NEW.reason,NEW.created_by,NEW.action_at)
    RETURNING * INTO target;
  NEW.target_id:=target.id; NEW.target_snapshot:=to_jsonb(target); NEW.item_pairs:='[]'::JSONB;
  FOR item IN SELECT * FROM invoice_items WHERE invoice_id=source.id ORDER BY id DESC LOOP
    SELECT e INTO requested FROM jsonb_array_elements(NEW.intent->'lines') e WHERE (e->>'itemId')::INTEGER=item.id;
    price:=(requested->>'unitPriceMinor')::NUMERIC;
    INSERT INTO invoice_items(invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor,
      plan_item_id,source_type,source_id)
      VALUES(target.id,item.service_id,item.doctor_id,item.description,item.quantity,price::BIGINT,(price*item.quantity)::BIGINT,
        item.plan_item_id,item.source_type,item.source_id) RETURNING id INTO inserted_id;
    NEW.item_pairs:=NEW.item_pairs||jsonb_build_array(jsonb_build_object('original',item.id,'corrected',inserted_id));
  END LOOP;
  SELECT jsonb_agg(to_jsonb(i) ORDER BY id) INTO NEW.target_items FROM invoice_items i WHERE invoice_id=target.id;
  RETURN NEW;
END $$;
CREATE TRIGGER u0_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_unpaid_currency_claims FOR EACH ROW EXECUTE FUNCTION u0_claim_guard();

-- Single deterministic lock order for all old/new reference owners. These are
-- KEY SHARE, not plan/visit/item row locks. U0 must never wait on those rows.
CREATE FUNCTION u0_reference_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp VOLATILE AS $$
DECLARE ids INTEGER[]:=ARRAY[]::INTEGER[]; field TEXT; root INTEGER; value INTEGER;
BEGIN
  FOREACH field IN ARRAY TG_ARGV LOOP
    IF TG_OP<>'INSERT' THEN value:=(to_jsonb(OLD)->>field)::INTEGER; IF value IS NOT NULL THEN ids:=array_append(ids,value); END IF; END IF;
    IF TG_OP<>'DELETE' THEN value:=(to_jsonb(NEW)->>field)::INTEGER; IF value IS NOT NULL THEN ids:=array_append(ids,value); END IF; END IF;
  END LOOP;
  IF TG_TABLE_NAME='payments' THEN
    FOR root IN SELECT invoice_id FROM payments WHERE id IN (
      (CASE WHEN TG_OP<>'INSERT' THEN (to_jsonb(OLD)->>'reversal_of_id')::INTEGER END),
      (CASE WHEN TG_OP<>'DELETE' THEN (to_jsonb(NEW)->>'reversal_of_id')::INTEGER END)) AND invoice_id IS NOT NULL
    LOOP ids:=array_append(ids,root); END LOOP;
  END IF;
  FOR root IN SELECT DISTINCT unnest(ids) ORDER BY 1 LOOP
    PERFORM id FROM invoices WHERE id=root FOR KEY SHARE;
    -- Separate post-wait query: RC must see a newly committed seal, RR must
    -- serialize-fail when the root version changed, not trust a stale snapshot.
    IF EXISTS(SELECT 1 FROM invoice_unpaid_currency_claims WHERE source_id=root) THEN
      RAISE EXCEPTION 'U0 sealed source reference refused'; END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
-- Names sort before existing guards so even append-only old/new operations
-- acquire the owner fence before their existing, unchanged refusal.
CREATE TRIGGER a0_u0_reference BEFORE INSERT OR UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION u0_reference_guard('invoice_id');
CREATE TRIGGER a0_u0_reference BEFORE INSERT OR UPDATE OR DELETE ON invoice_items FOR EACH ROW EXECUTE FUNCTION u0_reference_guard('invoice_id');
CREATE TRIGGER a0_u0_reference BEFORE INSERT OR UPDATE OR DELETE ON plan_items FOR EACH ROW EXECUTE FUNCTION u0_reference_guard('origin_invoice_id','billed_invoice_id');
CREATE TRIGGER a0_u0_reference BEFORE INSERT OR UPDATE OR DELETE ON clinical_cases FOR EACH ROW EXECUTE FUNCTION u0_reference_guard('origin_invoice_id');
CREATE TRIGGER a0_u0_reference BEFORE INSERT OR UPDATE OR DELETE ON visits FOR EACH ROW EXECUTE FUNCTION u0_reference_guard('invoice_id');
CREATE TRIGGER a0_u0_reference BEFORE INSERT OR UPDATE OR DELETE ON ortho_adjustments FOR EACH ROW EXECUTE FUNCTION u0_reference_guard('billing_invoice_id');
CREATE TRIGGER a0_u0_reference BEFORE INSERT OR UPDATE OR DELETE ON approved_agreement_principals FOR EACH ROW EXECUTE FUNCTION u0_reference_guard('invoice_id');
CREATE TRIGGER a0_u0_reference BEFORE INSERT OR UPDATE OR DELETE ON debt_repayment_arrangements FOR EACH ROW EXECUTE FUNCTION u0_reference_guard('invoice_id');

CREATE FUNCTION u0_source_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp VOLATILE SET timezone='UTC' AS $$
DECLARE claim invoice_unpaid_currency_claims%ROWTYPE;
BEGIN
  IF EXISTS(SELECT 1 FROM invoice_unpaid_currency_claims WHERE target_id=OLD.id) AND
    (TG_OP<>'UPDATE' OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status')) THEN
    RAISE EXCEPTION 'U0 target issuance facts are immutable'; END IF;
  SELECT * INTO claim FROM invoice_unpaid_currency_claims WHERE source_id=OLD.id;
  IF claim.source_id IS NOT NULL AND (TG_OP<>'UPDATE' OR claim.transaction_id<>pg_current_xact_id()
    OR to_jsonb(OLD) IS DISTINCT FROM claim.source_snapshot OR NEW.status<>'cancelled'
    OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (claim.source_snapshot-'status'))
    THEN RAISE EXCEPTION 'U0 source facts are immutable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER a0_u0_source BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION u0_source_guard();

CREATE FUNCTION u0_kind_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp VOLATILE AS $$
DECLARE claim invoice_unpaid_currency_claims%ROWTYPE; root INTEGER;
BEGIN
  FOR root IN SELECT DISTINCT unnest(ARRAY[NEW.original_invoice_id,NEW.corrected_invoice_id]) ORDER BY 1 LOOP
    PERFORM id FROM invoices WHERE id=root FOR KEY SHARE;
  END LOOP;
  IF EXISTS(SELECT 1 FROM invoice_unpaid_currency_claims WHERE source_id=NEW.corrected_invoice_id) THEN
    RAISE EXCEPTION 'U0 sealed source cannot become a correction target'; END IF;
  IF NEW.currency_evidence_kind='unpaid_root_v1' THEN
    SELECT * INTO claim FROM invoice_unpaid_currency_claims WHERE source_id=NEW.original_invoice_id;
    IF claim.source_id IS NULL OR claim.transaction_id<>pg_current_xact_id()
      OR claim.target_currency<>NEW.currency OR claim.source_snapshot->>'base_currency' IS DISTINCT FROM NEW.original_currency
      OR claim.target_id<>NEW.corrected_invoice_id OR claim.created_by<>NEW.created_by OR claim.reason<>NEW.reason
      THEN RAISE EXCEPTION 'U0 kind requires same-transaction authoritative root claim'; END IF;
  ELSIF EXISTS(SELECT 1 FROM invoice_unpaid_currency_claims WHERE source_id=NEW.original_invoice_id) THEN
    RAISE EXCEPTION 'U0 sealed source cannot use legacy kind';
  END IF;
  -- Legacy same-currency descendants remain legal. Second currency changes
  -- cannot escape through old v1 even if its YER -> SAR direction fits.
  IF NEW.original_currency IS NOT NULL AND NEW.original_currency<>NEW.currency AND EXISTS(
    WITH RECURSIVE ancestors(id) AS (SELECT NEW.original_invoice_id UNION
      SELECT c.original_invoice_id FROM invoice_corrections c JOIN ancestors a ON c.corrected_invoice_id=a.id)
    SELECT 1 FROM ancestors a JOIN invoice_unpaid_currency_transitions d ON d.target_id=a.id)
    THEN RAISE EXCEPTION 'U0 second currency transition refused'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a0_u0_kind BEFORE INSERT ON invoice_corrections FOR EACH ROW EXECUTE FUNCTION u0_kind_guard();

CREATE FUNCTION u0_document_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp VOLATILE SET timezone='UTC' AS $$
DECLARE correction invoice_corrections%ROWTYPE; claim invoice_unpaid_currency_claims%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'U0 document is immutable'; END IF;
  SELECT * INTO correction FROM invoice_corrections WHERE id=NEW.correction_id;
  SELECT * INTO claim FROM invoice_unpaid_currency_claims WHERE source_id=NEW.source_id;
  IF correction.id IS NULL OR correction.currency_evidence_kind<>'unpaid_root_v1'
    OR claim.source_id IS NULL OR claim.transaction_id<>pg_current_xact_id()
    OR correction.original_invoice_id<>NEW.source_id OR correction.corrected_invoice_id<>NEW.target_id
    OR claim.target_id<>NEW.target_id
    THEN RAISE EXCEPTION 'U0 document kind/identity mismatch'; END IF;
  NEW.target_snapshot:=claim.target_snapshot; NEW.target_items:=claim.target_items;
  RETURN NEW;
END $$;
CREATE TRIGGER u0_document_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_unpaid_currency_transitions FOR EACH ROW EXECUTE FUNCTION u0_document_guard();
CREATE FUNCTION u0_captured_membership_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='invoice_correction_lines' THEN
    IF EXISTS(SELECT 1 FROM invoice_unpaid_currency_transitions WHERE correction_id=NEW.correction_id)
      THEN RAISE EXCEPTION 'U0 captured pair membership is immutable'; END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM invoice_unpaid_currency_claims WHERE target_id IN (
      CASE WHEN TG_OP<>'INSERT' THEN OLD.invoice_id END, CASE WHEN TG_OP<>'DELETE' THEN NEW.invoice_id END))
      THEN RAISE EXCEPTION 'U0 target item issuance facts are immutable'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER a1_u0_target_items BEFORE INSERT OR UPDATE OR DELETE ON invoice_items FOR EACH ROW EXECUTE FUNCTION u0_captured_membership_guard();
CREATE TRIGGER a0_u0_pair_membership BEFORE INSERT ON invoice_correction_lines FOR EACH ROW EXECUTE FUNCTION u0_captured_membership_guard();
CREATE FUNCTION u0_legacy_document_kind() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM invoice_corrections WHERE id=NEW.correction_id AND currency_evidence_kind='legacy_v1')
    THEN RAISE EXCEPTION 'Legacy document requires legacy kind'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a0_u0_legacy_kind BEFORE INSERT ON invoice_settlement_reclassifications FOR EACH ROW EXECUTE FUNCTION u0_legacy_document_kind();

-- Complete new acknowledgement semantics, independent of legacy v1 bytes.
CREATE FUNCTION u0_ack_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE c invoice_corrections%ROWTYPE; k invoice_unpaid_currency_claims%ROWTYPE; r JSONB;
BEGIN
  SELECT * INTO c FROM invoice_corrections WHERE id=NEW.correction_id;
  IF c.currency_evidence_kind<>'unpaid_root_v1' THEN RETURN NEW; END IF;
  SELECT * INTO k FROM invoice_unpaid_currency_claims WHERE source_id=c.original_invoice_id;
  r:=NEW.receipt;
  IF r->>'version' IS DISTINCT FROM '1' OR r->>'kind' IS DISTINCT FROM 'invoice-currency-correction'
    OR r->>'evidenceKind' IS DISTINCT FROM 'unpaid_root_v1' OR (r->>'correctionId')::INTEGER IS DISTINCT FROM c.id
    OR r->>'requestHash' IS DISTINCT FROM c.request_hash OR r->>'originalCurrency' IS DISTINCT FROM c.original_currency
    OR r->>'amountMode' IS DISTINCT FROM k.intent->>'mode' OR r->>'settledMinor' IS DISTINCT FROM '0'
    OR (r->>'sourcePrincipalMinor')::NUMERIC IS DISTINCT FROM (k.source_snapshot->>'total_minor')::NUMERIC-(k.source_snapshot->>'discount_minor')::NUMERIC
    OR (r->>'targetPrincipalMinor')::NUMERIC IS DISTINCT FROM (k.target_snapshot->>'total_minor')::NUMERIC-(k.target_snapshot->>'discount_minor')::NUMERIC
    OR r->>'effectiveAt' IS DISTINCT FROM to_char(k.action_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    OR r#>>'{corrected,createdAt}' IS DISTINCT FROM r->>'effectiveAt'
    OR r#>>'{original,createdAt}' IS DISTINCT FROM to_char((k.source_snapshot->>'created_at')::TIMESTAMPTZ AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    OR r#>>'{original,invoiceNumber}' IS DISTINCT FROM k.source_snapshot->>'invoice_number'
    OR r#>>'{corrected,invoiceNumber}' IS DISTINCT FROM k.target_snapshot->>'invoice_number'
    OR NOT EXISTS(SELECT 1 FROM users WHERE id=(r->>'actorUserId')::INTEGER AND username=c.created_by AND role='admin' AND is_active)
    THEN RAISE EXCEPTION 'U0 acknowledgement facts mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a0_u0_ack BEFORE INSERT ON invoice_correction_receipts FOR EACH ROW EXECUTE FUNCTION u0_ack_guard();

CREATE FUNCTION u0_complete() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp VOLATILE SET timezone='UTC' AS $$
DECLARE claim invoice_unpaid_currency_claims%ROWTYPE; document invoice_unpaid_currency_transitions%ROWTYPE;
  correction invoice_corrections%ROWTYPE; source invoices%ROWTYPE; target invoices%ROWTYPE;
  current_items JSONB; pair RECORD; intended JSONB; source_scale NUMERIC; target_scale NUMERIC;
BEGIN
  IF TG_TABLE_NAME='invoice_unpaid_currency_claims' THEN SELECT * INTO claim FROM invoice_unpaid_currency_claims WHERE source_id=NEW.source_id;
  ELSE SELECT * INTO claim FROM invoice_unpaid_currency_claims WHERE source_id=NEW.original_invoice_id; END IF;
  SELECT * INTO document FROM invoice_unpaid_currency_transitions WHERE source_id=claim.source_id;
  SELECT * INTO correction FROM invoice_corrections WHERE id=document.correction_id;
  IF claim.source_id IS NULL OR document.correction_id IS NULL OR correction.currency_evidence_kind IS DISTINCT FROM 'unpaid_root_v1'
    OR EXISTS(SELECT 1 FROM invoice_settlement_reclassifications WHERE correction_id=correction.id)
    THEN RAISE EXCEPTION 'U0 complete document missing or cross-kind'; END IF;
  IF NOT EXISTS(SELECT 1 FROM audit_log WHERE action='invoice.correct' AND entity='invoice' AND entity_id=claim.source_id::TEXT
    AND actor=correction.created_by AND details->>'evidenceKind'='unpaid_root_v1'
    AND (details->>'correctionId')::INTEGER=correction.id AND (details->>'replacementId')::INTEGER=document.target_id)
    THEN RAISE EXCEPTION 'U0 cancellation audit missing'; END IF;
  SELECT * INTO source FROM invoices WHERE id=claim.source_id;
  SELECT * INTO target FROM invoices WHERE id=document.target_id;
  IF source.status<>'cancelled' OR (to_jsonb(source)-'status') IS DISTINCT FROM (claim.source_snapshot-'status')
    OR target.patient_id<>source.patient_id OR target.base_currency<>claim.target_currency OR target.status='cancelled'
    OR to_jsonb(target) IS DISTINCT FROM document.target_snapshot
    OR target.created_at<claim.action_at OR correction.created_at<>claim.action_at
    OR EXISTS(SELECT 1 FROM invoice_corrections WHERE (corrected_invoice_id=source.id OR original_invoice_id=source.id) AND id<>correction.id)
    OR EXISTS(SELECT 1 FROM invoice_corrections WHERE (corrected_invoice_id=target.id OR original_invoice_id=target.id) AND id<>correction.id)
    THEN RAISE EXCEPTION 'U0 document/root facts mismatch'; END IF;
  PERFORM u0_assert_empty(source.id); PERFORM u0_assert_empty(target.id);
  SELECT jsonb_agg(to_jsonb(i) ORDER BY id) INTO current_items FROM invoice_items i WHERE invoice_id=source.id;
  IF current_items IS DISTINCT FROM claim.item_snapshot THEN RAISE EXCEPTION 'U0 source item membership changed'; END IF;
  SELECT jsonb_agg(to_jsonb(i) ORDER BY id) INTO current_items FROM invoice_items i WHERE invoice_id=target.id;
  IF current_items IS DISTINCT FROM document.target_items
    OR jsonb_array_length(current_items)<>jsonb_array_length(claim.item_snapshot)
    OR jsonb_array_length(claim.intent->'lines')<>jsonb_array_length(claim.item_snapshot)
    OR (SELECT count(*) FROM invoice_correction_lines WHERE correction_id=correction.id)<>jsonb_array_length(claim.item_snapshot)
    OR EXISTS(SELECT 1 FROM invoice_correction_lines WHERE correction_id=correction.id AND original_item_id IS NULL)
    OR (SELECT array_agg(original_item_id ORDER BY original_item_id) FROM invoice_correction_lines WHERE correction_id=correction.id)
      IS DISTINCT FROM (SELECT array_agg((value->>'id')::INTEGER ORDER BY (value->>'id')::INTEGER) FROM jsonb_array_elements(claim.item_snapshot))
    OR (SELECT array_agg(corrected_item_id ORDER BY corrected_item_id) FROM invoice_correction_lines WHERE correction_id=correction.id)
      IS DISTINCT FROM (SELECT array_agg((value->>'id')::INTEGER ORDER BY (value->>'id')::INTEGER) FROM jsonb_array_elements(document.target_items))
    THEN RAISE EXCEPTION 'U0 complete item pairs missing'; END IF;
  IF (SELECT jsonb_agg(jsonb_build_object('original',original_item_id,'corrected',corrected_item_id) ORDER BY original_item_id DESC)
    FROM invoice_correction_lines WHERE correction_id=correction.id) IS DISTINCT FROM claim.item_pairs
    THEN RAISE EXCEPTION 'U0 pairs must be exact DB-issued identities'; END IF;
  source_scale:=CASE WHEN source.base_currency='YER' THEN 1 ELSE 100 END;
  target_scale:=CASE WHEN target.base_currency='YER' THEN 1 ELSE 100 END;
  FOR pair IN SELECT m.*,to_jsonb(a) AS a,to_jsonb(b) AS b FROM invoice_correction_lines m
    JOIN invoice_items a ON a.id=m.original_item_id JOIN invoice_items b ON b.id=m.corrected_item_id WHERE m.correction_id=correction.id LOOP
    SELECT value INTO intended FROM jsonb_array_elements(claim.intent->'lines') WHERE (value->>'itemId')::INTEGER=pair.original_item_id;
    IF pair.plan_item_id IS NOT NULL OR intended IS NULL
      OR (SELECT count(*) FROM jsonb_array_elements(claim.intent->'lines') WHERE (value->>'itemId')::INTEGER=pair.original_item_id)<>1
      OR (pair.a-ARRAY['id','invoice_id','unit_price_minor','total_minor']) IS DISTINCT FROM (pair.b-ARRAY['id','invoice_id','unit_price_minor','total_minor'])
      OR (pair.b->>'unit_price_minor')::NUMERIC<>(intended->>'unitPriceMinor')::NUMERIC
      OR (pair.b->>'unit_price_minor')::NUMERIC NOT BETWEEN 0 AND 9007199254740991
      OR (pair.b->>'total_minor')::NUMERIC<>(pair.b->>'unit_price_minor')::NUMERIC*(pair.b->>'quantity')::NUMERIC
      OR claim.intent->>'mode'='preserve-numerals' AND (pair.b->>'unit_price_minor')::NUMERIC<>(pair.a->>'unit_price_minor')::NUMERIC*target_scale/source_scale
      THEN RAISE EXCEPTION 'U0 exact item/intent proof mismatch'; END IF;
  END LOOP;
  IF target.discount_minor::NUMERIC<>(claim.intent->>'discountMinor')::NUMERIC
    OR target.discount_minor NOT BETWEEN 0 AND target.total_minor
    OR target.total_minor>9007199254740991
    OR target.total_minor<>(SELECT sum(total_minor) FROM invoice_items WHERE invoice_id=target.id)
    OR claim.intent->>'mode'='preserve-numerals' AND target.discount_minor::NUMERIC<>source.discount_minor::NUMERIC*target_scale/source_scale
    THEN RAISE EXCEPTION 'U0 exact total/discount intent mismatch'; END IF;
  RETURN NEW;
END $$;
-- Topology changes only: existing 0063 function body remains byte-identical.
DROP TRIGGER invoice_reclassification_complete ON invoice_corrections;
CREATE CONSTRAINT TRIGGER invoice_reclassification_complete AFTER INSERT ON invoice_corrections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.currency_evidence_kind='legacy_v1') EXECUTE FUNCTION aqlan_reclassification_complete();
CREATE CONSTRAINT TRIGGER u0_correction_complete AFTER INSERT ON invoice_corrections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.currency_evidence_kind='unpaid_root_v1') EXECUTE FUNCTION u0_complete();
CREATE CONSTRAINT TRIGGER u0_claim_complete AFTER INSERT ON invoice_unpaid_currency_claims
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION u0_complete();
`;

CREATE OR REPLACE FUNCTION aqlan_reconciliation_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_owner INTEGER; new_owner INTEGER;
BEGIN
 IF TG_TABLE_NAME='invoice_items' THEN
  old_owner := CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.invoice_id END;
  new_owner := CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.invoice_id END;
  IF EXISTS(SELECT 1 FROM agreement_reconciliation_sources WHERE invoice_id IN(old_owner,new_owner)) THEN RAISE EXCEPTION 'reconciled invoice items are immutable'; END IF;
 ELSE
  old_owner := CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.plan_id END;
  new_owner := CASE WHEN TG_OP='DELETE' THEN NULL ELSE NEW.plan_id END;
  IF EXISTS(SELECT 1 FROM agreement_reconciliations WHERE plan_id IN(old_owner,new_owner)) THEN
   -- Only reminder metadata may change. Comparing the entire remaining row also protects future columns.
   IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'reconciled schedule requires financial review'; END IF;
   IF (to_jsonb(NEW) - 'last_reminder_at') IS DISTINCT FROM (to_jsonb(OLD) - 'last_reminder_at') THEN
    RAISE EXCEPTION 'reconciled schedule requires financial review';
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

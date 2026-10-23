-- 0069: currency transition of an unpaid invoice lineage in any direction.
-- The existing 0063 document stays the only evidence of a currency change. A
-- receipt-backed reclassification remains YER -> SAR only; every other distinct
-- direction is accepted only while no receipt has ever referenced the lineage,
-- so no settlement is moved and no exchange rate is applied. Target amounts are
-- the explicit replacement invoice lines. Validation only: replaying a backup
-- re-inserts the same rows and passes the same checks; nothing is generated.
ALTER TABLE invoice_settlement_reclassifications
  DROP CONSTRAINT invoice_settlement_reclassifications_source_currency_check,
  DROP CONSTRAINT invoice_settlement_reclassifications_target_currency_check,
  ADD CONSTRAINT invoice_settlement_reclassifications_direction_check
    CHECK (source_currency IN ('YER','SAR','USD') AND target_currency IN ('YER','SAR','USD')
      AND source_currency <> target_currency);
CREATE OR REPLACE FUNCTION aqlan_unpaid_currency_transition_guard() RETURNS TRIGGER AS $$
DECLARE document invoice_settlement_reclassifications%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='invoice_settlement_reclassifications' THEN
    IF NEW.source_currency='YER' AND NEW.target_currency='SAR' THEN RETURN NEW; END IF;
    -- FOR UPDATE conflicts with the KEY SHARE a receipt insert takes on its
    -- invoice: an in-flight receipt is waited for and then seen; a later one
    -- waits for this document and is refused by the 0063 follow trigger.
    PERFORM id FROM invoices WHERE id=ANY(NEW.source_invoice_ids) ORDER BY id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM payments WHERE invoice_id=ANY(NEW.source_invoice_ids)) THEN
      RAISE EXCEPTION 'unpaid currency transition refused: the invoice lineage has a receipt'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO document FROM invoice_settlement_reclassifications WHERE id=NEW.reclassification_id;
  IF document.id IS NOT NULL AND NOT (document.source_currency='YER' AND document.target_currency='SAR') THEN
    RAISE EXCEPTION 'unpaid currency transition refused: receipt events need a YER to SAR document'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER invoice_reclassification_direction_guard BEFORE INSERT ON invoice_settlement_reclassifications
  FOR EACH ROW EXECUTE FUNCTION aqlan_unpaid_currency_transition_guard();
CREATE TRIGGER invoice_reclassification_event_direction_guard BEFORE INSERT ON invoice_settlement_reclassification_events
  FOR EACH ROW EXECUTE FUNCTION aqlan_unpaid_currency_transition_guard();

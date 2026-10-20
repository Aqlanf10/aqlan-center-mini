-- A command receipt is not a second stock/payable ledger. Preserve on rollback.
CREATE TABLE inventory_purchase_receipts (
  request_key UUID PRIMARY KEY,
  actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  fingerprint_version SMALLINT NOT NULL CHECK (fingerprint_version = 1),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('committed', 'rejected')),
  movement_id INTEGER UNIQUE REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  result_version SMALLINT NOT NULL CHECK (result_version = 1),
  result_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT inventory_purchase_receipt_snapshot CHECK ((
    jsonb_typeof(result_snapshot) = 'object' AND (
      (outcome = 'committed' AND movement_id IS NOT NULL
       AND result_snapshot ?& ARRAY['balance','movement']
       AND result_snapshot - ARRAY['balance','movement'] = '{}'::jsonb
       AND jsonb_typeof(result_snapshot->'balance') = 'number'
       AND jsonb_typeof(result_snapshot->'movement') = 'object'
       AND (result_snapshot->'movement') ?& ARRAY['id','itemId','kind','qty','expiryDate','reason','visitId','createdBy','createdAt','unitCostMinor','isReturn','partyId','payableId']
       AND (result_snapshot->'movement') - ARRAY['id','itemId','kind','qty','expiryDate','reason','visitId','createdBy','createdAt','unitCostMinor','isReturn','partyId','payableId'] = '{}'::jsonb
       AND result_snapshot->'movement'->'id' = to_jsonb(movement_id)
       AND jsonb_typeof(result_snapshot->'movement'->'itemId') = 'number'
       AND (result_snapshot->'movement'->>'itemId') ~ '^[1-9][0-9]*$'
       AND (result_snapshot->'movement'->>'itemId')::numeric <= 2147483647
       AND jsonb_typeof(result_snapshot->'movement'->'qty') = 'number'
       AND (result_snapshot->'movement'->>'qty')::numeric > 0
       AND jsonb_typeof(result_snapshot->'movement'->'expiryDate') IN ('null','string')
       AND jsonb_typeof(result_snapshot->'movement'->'reason') IN ('null','string')
       AND result_snapshot->'movement'->'visitId' = 'null'::jsonb
       AND jsonb_typeof(result_snapshot->'movement'->'createdBy') = 'string'
       AND jsonb_typeof(result_snapshot->'movement'->'createdAt') = 'string'
       AND (result_snapshot->'movement'->>'createdAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
       AND (result_snapshot->'movement'->'unitCostMinor' = 'null'::jsonb OR
         (jsonb_typeof(result_snapshot->'movement'->'unitCostMinor') = 'number'
          AND (result_snapshot->'movement'->>'unitCostMinor') ~ '^[0-9]+$'
          AND (result_snapshot->'movement'->>'unitCostMinor')::numeric <= 9007199254740991))
       AND (result_snapshot->'movement'->'partyId' = 'null'::jsonb OR
         (jsonb_typeof(result_snapshot->'movement'->'partyId') = 'number'
          AND (result_snapshot->'movement'->>'partyId') ~ '^[1-9][0-9]*$'))
       AND (result_snapshot->'movement'->'payableId' = 'null'::jsonb OR
         (jsonb_typeof(result_snapshot->'movement'->'payableId') = 'number'
          AND (result_snapshot->'movement'->>'payableId') ~ '^[1-9][0-9]*$'))
       AND result_snapshot->'movement'->>'kind' = 'in'
       AND result_snapshot->'movement'->'isReturn' = 'false'::jsonb)
      OR
      (outcome = 'rejected' AND movement_id IS NULL
       AND result_snapshot ?& ARRAY['message','httpStatus']
       AND result_snapshot - ARRAY['message','httpStatus'] = '{}'::jsonb
       AND jsonb_typeof(result_snapshot->'message') = 'string'
       AND length(result_snapshot->>'message') BETWEEN 1 AND 500
       AND result_snapshot->'httpStatus' IN ('400'::jsonb, '404'::jsonb, '409'::jsonb))
    )
  ) IS TRUE)
);
CREATE FUNCTION aqlan_inventory_purchase_receipt_immutable() RETURNS TRIGGER AS $$
BEGIN
  -- TRUNCATE already holds ACCESS EXCLUSIVE: an empty-table reset removes no
  -- keys, and no concurrent INSERT can race this final defensive check.
  IF TG_OP = 'TRUNCATE' AND NOT EXISTS (SELECT 1 FROM inventory_purchase_receipts) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'inventory purchase receipts are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER inventory_purchase_receipts_immutable
  BEFORE UPDATE OR DELETE ON inventory_purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION aqlan_inventory_purchase_receipt_immutable();
CREATE TRIGGER inventory_purchase_receipts_no_truncate
  BEFORE TRUNCATE ON inventory_purchase_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_inventory_purchase_receipt_immutable();

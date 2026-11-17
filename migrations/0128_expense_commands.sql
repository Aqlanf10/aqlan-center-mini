-- Expense commands: duplicate protection and the real payment source of each voucher.
-- Owner decision #483 6831365228 (items 2 and 3); number allocated in #483 6833690789.
-- Contract: docs/finance/EXPENSE_COMMANDS_0128.md.
-- Nothing is backfilled. A voucher written before 0128 keeps NULL in every new column: its key is
-- unknown and its whole amount left the drawer, the only source that existed.
ALTER TABLE expenses ADD COLUMN idempotency_key TEXT;
ALTER TABLE expenses ADD COLUMN idempotency_request_hash TEXT;
ALTER TABLE expenses ADD COLUMN payment_source TEXT;
ALTER TABLE expenses ADD COLUMN drawer_amount_minor BIGINT;
ALTER TABLE expenses ADD COLUMN owner_private_amount_minor BIGINT;
ALTER TABLE expenses ADD COLUMN owner_private_reason TEXT;
ALTER TABLE expenses ADD COLUMN owner_private_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX expenses_idempotency_key_uniq ON expenses (idempotency_key)
 WHERE idempotency_key IS NOT NULL;
ALTER TABLE expenses ADD CONSTRAINT expenses_idempotency_valid CHECK (
 (idempotency_key IS NULL) = (idempotency_request_hash IS NULL)
 AND (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$')
 AND (idempotency_request_hash IS NULL OR idempotency_request_hash ~ '^[0-9a-f]{64}$')
 AND (idempotency_key IS NULL OR reversal_of_id IS NULL)
);
ALTER TABLE expenses ADD CONSTRAINT expenses_payment_source_valid CHECK (
 (payment_source IS NULL AND drawer_amount_minor IS NULL AND owner_private_amount_minor IS NULL
  AND owner_private_reason IS NULL AND owner_private_user_id IS NULL)
 OR (payment_source IS NOT NULL AND drawer_amount_minor IS NOT NULL AND owner_private_amount_minor IS NOT NULL
  AND drawer_amount_minor + owner_private_amount_minor = amount_minor
  AND sign(drawer_amount_minor) IN (0, sign(amount_minor))
  AND sign(owner_private_amount_minor) IN (0, sign(amount_minor))
  AND CASE payment_source
   WHEN 'drawer' THEN owner_private_amount_minor = 0
    AND owner_private_reason IS NULL AND owner_private_user_id IS NULL
   WHEN 'owner_private' THEN drawer_amount_minor = 0 AND owner_private_amount_minor <> 0
   WHEN 'drawer_and_owner_private' THEN drawer_amount_minor <> 0 AND owner_private_amount_minor <> 0
   ELSE FALSE END
  AND (payment_source = 'drawer' OR (owner_private_user_id IS NOT NULL
   AND owner_private_reason IS NOT NULL AND owner_private_reason = btrim(owner_private_reason)
   AND char_length(owner_private_reason) BETWEEN 3 AND 300)))
);
CREATE FUNCTION aqlan_expense_command_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  OR NEW.idempotency_request_hash IS DISTINCT FROM OLD.idempotency_request_hash
  OR NEW.payment_source IS DISTINCT FROM OLD.payment_source
  OR NEW.drawer_amount_minor IS DISTINCT FROM OLD.drawer_amount_minor
  OR NEW.owner_private_amount_minor IS DISTINCT FROM OLD.owner_private_amount_minor
  OR NEW.owner_private_reason IS DISTINCT FROM OLD.owner_private_reason
  OR NEW.owner_private_user_id IS DISTINCT FROM OLD.owner_private_user_id THEN
  RAISE EXCEPTION 'expenses مفتاح الطلب ومصدر الدفع تاريخيان (append-only): التصحيح بقيد إبطال معاكس صريح.';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER expenses_command_append_only BEFORE UPDATE ON expenses
 FOR EACH ROW EXECUTE FUNCTION aqlan_expense_command_append_only_guard();

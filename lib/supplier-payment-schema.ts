/**
 * (P0-2) لقطة تسوية التزامات الموردين والمختبرات — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0013_supplier_payment_settlement.sql` حرفيًّا — والاختبار
 * `__tests__/supplier-payment-schema.test.ts` يُسقط البناء إن افترقا.
 */
export const SUPPLIER_PAYMENT_SETTLEMENT_SQL = `ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payable_currency      TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payable_amount_minor  BIGINT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payable_exchange_rate NUMERIC(18,6);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payable_settled_minor BIGINT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rate_override_reason  TEXT;
ALTER TABLE lab_order_tracking ADD COLUMN IF NOT EXISTS expense_id INTEGER REFERENCES expenses(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS expenses_payable_idx ON expenses (payable_id) WHERE payable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lab_order_tracking_expense_idx ON lab_order_tracking (expense_id) WHERE expense_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_payable_currency_valid') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_payable_currency_valid
      CHECK (payable_currency IS NULL OR payable_currency IN ('YER', 'SAR', 'USD')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_payable_rate_positive') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_payable_rate_positive
      CHECK (payable_exchange_rate IS NULL OR payable_exchange_rate > 0) NOT VALID;
  END IF;
END $$;

UPDATE expenses e
   SET payable_currency      = p.currency,
       payable_amount_minor  = p.amount_minor,
       payable_exchange_rate = CASE
         WHEN p.currency = e.base_currency THEN 1
         WHEN p.currency = e.currency THEN e.exchange_rate
         ELSE p.exchange_rate
       END,
       payable_settled_minor = CASE
         WHEN p.currency = e.currency THEN e.amount_minor
         WHEN p.currency = e.base_currency THEN e.base_amount_minor
         ELSE ROUND(e.base_amount_minor::numeric / NULLIF(p.exchange_rate, 0)
                    * (CASE p.currency WHEN 'YER' THEN 1 ELSE 100 END))::bigint
       END
  FROM payables p
 WHERE p.id = e.payable_id
   AND e.payable_settled_minor IS NULL;

CREATE OR REPLACE FUNCTION aqlan_expense_settlement_guard() RETURNS trigger AS $$
BEGIN
  IF (OLD.payable_currency IS NOT NULL AND NEW.payable_currency IS DISTINCT FROM OLD.payable_currency)
     OR (OLD.payable_amount_minor IS NOT NULL AND NEW.payable_amount_minor IS DISTINCT FROM OLD.payable_amount_minor)
     OR (OLD.payable_exchange_rate IS NOT NULL AND NEW.payable_exchange_rate IS DISTINCT FROM OLD.payable_exchange_rate)
     OR (OLD.payable_settled_minor IS NOT NULL AND NEW.payable_settled_minor IS DISTINCT FROM OLD.payable_settled_minor)
     OR (OLD.rate_override_reason IS NOT NULL AND NEW.rate_override_reason IS DISTINCT FROM OLD.rate_override_reason) THEN
    RAISE EXCEPTION 'expenses لقطة تسوية الالتزام تاريخية (append-only): عملة الفاتورة وقيمتها وسعر الصرف والمكافئ المخصوم لا تُعدَّل — التصحيح بقيد إبطال معاكس.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS expenses_settlement_append_only ON expenses;
CREATE TRIGGER expenses_settlement_append_only BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION aqlan_expense_settlement_guard();
`;

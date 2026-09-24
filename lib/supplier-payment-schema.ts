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

CREATE TABLE IF NOT EXISTS expense_payable_allocations (
  id                    SERIAL PRIMARY KEY,
  expense_id            INTEGER       NOT NULL REFERENCES expenses(id) ON DELETE RESTRICT,
  payable_id            INTEGER       NOT NULL REFERENCES payables(id) ON DELETE RESTRICT,
  paid_minor            BIGINT        NOT NULL,
  payable_currency      TEXT          NOT NULL CHECK (payable_currency IN ('YER', 'SAR', 'USD')),
  payable_exchange_rate NUMERIC(18,6) NOT NULL CHECK (payable_exchange_rate > 0),
  settled_minor         BIGINT        NOT NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS expense_payable_allocations_payable_idx ON expense_payable_allocations (payable_id);
CREATE INDEX IF NOT EXISTS expense_payable_allocations_expense_idx ON expense_payable_allocations (expense_id);

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

SELECT set_config('aqlan.settlement_backfill', 'on', true);
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
SELECT set_config('aqlan.settlement_backfill', 'off', true);

CREATE OR REPLACE FUNCTION aqlan_expense_settlement_guard() RETURNS trigger AS $$
BEGIN
  IF (NEW.payable_id IS NOT NULL AND NEW.payable_id IS DISTINCT FROM OLD.payable_id) THEN
    RAISE EXCEPTION 'expenses ربط سندٍ قائم بالتزام بعد تسجيله ممنوع (append-only): السداد يُسجَّل سندًا جديدًا بلقطته.';
  END IF;
  IF (NEW.payable_currency IS DISTINCT FROM OLD.payable_currency
      OR NEW.payable_amount_minor IS DISTINCT FROM OLD.payable_amount_minor
      OR NEW.payable_exchange_rate IS DISTINCT FROM OLD.payable_exchange_rate
      OR NEW.payable_settled_minor IS DISTINCT FROM OLD.payable_settled_minor
      OR NEW.rate_override_reason IS DISTINCT FROM OLD.rate_override_reason)
     AND NOT (OLD.payable_settled_minor IS NULL
              AND OLD.payable_id IS NOT NULL
              AND current_setting('aqlan.settlement_backfill', true) = 'on') THEN
    RAISE EXCEPTION 'expenses لقطة تسوية الالتزام تاريخية (append-only): عملة الفاتورة وقيمتها وسعر الصرف والمكافئ المخصوم لا تُعدَّل — التصحيح بقيد إبطال معاكس.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS expenses_settlement_append_only ON expenses;
CREATE TRIGGER expenses_settlement_append_only BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION aqlan_expense_settlement_guard();

CREATE OR REPLACE FUNCTION aqlan_expense_allocation_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'expense_payable_allocations توزيع سندٍ على التزاماته تاريخي (append-only): التصحيح بقيد إبطال معاكس.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS expense_payable_allocations_no_update ON expense_payable_allocations;
CREATE TRIGGER expense_payable_allocations_no_update BEFORE UPDATE ON expense_payable_allocations
  FOR EACH ROW EXECUTE FUNCTION aqlan_expense_allocation_append_only_guard();
DROP TRIGGER IF EXISTS expense_payable_allocations_no_delete ON expense_payable_allocations;
CREATE TRIGGER expense_payable_allocations_no_delete BEFORE DELETE ON expense_payable_allocations
  FOR EACH ROW EXECUTE FUNCTION aqlan_expense_allocation_append_only_guard();
`;

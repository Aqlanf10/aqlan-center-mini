/**
 * (P2-5 + P2-9) ضوابط المال في قاعدة البيانات — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0016_finance_controls.sql` حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * - سجلّ الرصيد الافتتاحي (append-only): كل إثباتٍ أو تعديلٍ أو مسحٍ سطرٌ بقبل/بعد
 *   وسببه وفاعله. الجدول الحالي يبقى مصدر الرصيد للتقارير كما هو؛ والتاريخ لا يُعاد
 *   كتابته — حتى من psql.
 * - قيود CHECK على الدفعات والفواتير والمصروفات: دفاعٌ ثانٍ خلف تحقق الـAPI. تُضاف
 *   NOT VALID فلا تُسقط الهجرة بصفٍّ قديم، وتُفرض على كل صفٍّ جديد.
 */
export const FINANCE_CONTROLS_SQL = `CREATE TABLE IF NOT EXISTS patient_opening_balance_history (
  id                  SERIAL      PRIMARY KEY,
  patient_id          INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  action              TEXT        NOT NULL CHECK (action IN ('set', 'clear')),
  before_amount_minor BIGINT,
  before_as_of_date   DATE,
  after_amount_minor  BIGINT,
  after_as_of_date    DATE,
  note                TEXT,
  reason              TEXT,
  actor               TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS patient_opening_balance_history_patient_idx
  ON patient_opening_balance_history (patient_id, id);

CREATE OR REPLACE FUNCTION aqlan_opening_history_append_only() RETURNS trigger AS $$
BEGIN
  -- حذف المريض نفسه (التتالي) يُسقط تاريخه معه؛ وما عداه لا يُمسّ.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM patients WHERE id = OLD.patient_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'patient_opening_balance_history سجلّ الرصيد الافتتاحي append-only: لا يُعدَّل ولا يُحذف — التصحيح إثباتٌ جديد بسببه.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS patient_opening_balance_history_append_only ON patient_opening_balance_history;
CREATE TRIGGER patient_opening_balance_history_append_only BEFORE UPDATE OR DELETE ON patient_opening_balance_history
  FOR EACH ROW EXECUTE FUNCTION aqlan_opening_history_append_only();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_amount_positive') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount_minor > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_kind_known') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_kind_known CHECK (kind IN ('payment', 'refund')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_currency_known') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_currency_known CHECK (currency IN ('YER', 'SAR', 'USD')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_amounts_sane') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_amounts_sane
      CHECK (total_minor >= 0 AND discount_minor >= 0 AND discount_minor <= total_minor) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_currency_known') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_currency_known CHECK (base_currency IN ('YER', 'SAR', 'USD')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_currency_known') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_currency_known CHECK (currency IN ('YER', 'SAR', 'USD')) NOT VALID;
  END IF;
END $$;
`;

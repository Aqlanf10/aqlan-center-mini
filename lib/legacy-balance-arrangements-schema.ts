/**
 * (P0-C) ترتيب تحصيل الرصيد السابق — جدول مواعيد/اقتراح تحصيل فقط.
 *
 * لا ينشئ دينًا ولا فاتورة ولا سندًا. المصدر المالي الوحيد يبقى
 * patient_opening_balances + payments(opening_currency).
 */
export const LEGACY_BALANCE_ARRANGEMENTS_SQL = `CREATE TABLE IF NOT EXISTS legacy_balance_arrangements (
  id                 SERIAL      PRIMARY KEY,
  patient_id         INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  currency           TEXT        NOT NULL CHECK (currency IN ('YER', 'SAR', 'USD')),
  cadence            TEXT        NOT NULL CHECK (cadence IN ('per_visit', 'monthly')),
  installment_minor  BIGINT      NOT NULL CHECK (installment_minor > 0),
  starting_due_minor BIGINT      NOT NULL CHECK (starting_due_minor > 0),
  first_due_date     DATE,
  note               TEXT,
  created_by         TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_by       TEXT,
  cancelled_at       TIMESTAMPTZ,
  cancel_reason      TEXT,
  CONSTRAINT legacy_balance_arrangements_monthly_date_check
    CHECK (cadence <> 'monthly' OR first_due_date IS NOT NULL),
  CONSTRAINT legacy_balance_arrangements_cancel_check
    CHECK (
      (cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL)
      OR
      (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
       AND cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) >= 3)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS legacy_balance_arrangements_one_active_idx
  ON legacy_balance_arrangements (patient_id, currency)
  WHERE cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS legacy_balance_arrangements_patient_idx
  ON legacy_balance_arrangements (patient_id, created_at DESC);
`;

-- (P1-5b) Opening balances keep their currency (owner: SAR stays SAR, USD stays USD).
-- Body must remain byte-for-byte equal to OPENING_CURRENCY_SQL after these comments.
ALTER TABLE patient_opening_balances ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'YER';
ALTER TABLE patient_opening_balance_history ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'YER';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS opening_currency TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_opening_balances_currency_check') THEN
    ALTER TABLE patient_opening_balances
      ADD CONSTRAINT patient_opening_balances_currency_check CHECK (currency IN ('YER', 'SAR', 'USD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_opening_balance_history_currency_check') THEN
    ALTER TABLE patient_opening_balance_history
      ADD CONSTRAINT patient_opening_balance_history_currency_check CHECK (currency IN ('YER', 'SAR', 'USD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_opening_currency_check') THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_opening_currency_check CHECK (
        opening_currency IS NULL
        OR (opening_currency IN ('YER', 'SAR', 'USD') AND invoice_id IS NULL AND plan_id IS NULL)
      );
  END IF;
  IF (SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conname = 'patient_opening_balances_pkey') IS DISTINCT FROM ARRAY['currency', 'patient_id'] THEN
    ALTER TABLE patient_opening_balances DROP CONSTRAINT IF EXISTS patient_opening_balances_pkey;
    ALTER TABLE patient_opening_balances ADD CONSTRAINT patient_opening_balances_pkey PRIMARY KEY (patient_id, currency);
  END IF;
END $$;

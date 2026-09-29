-- (FIA-1) Party (lab/supplier) opening balances: opening payables in payables with an explicit
-- source_type, append-only corrections, and opening advances in their own table. Additive only.
-- Body must remain byte-for-byte equal to PARTY_OPENING_SQL after these comments.
ALTER TABLE payables ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'operational';
ALTER TABLE payables ADD COLUMN IF NOT EXISTS as_of_date DATE;
ALTER TABLE payables ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE payables ADD COLUMN IF NOT EXISTS opening_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payables_source_type_check') THEN
    ALTER TABLE payables ADD CONSTRAINT payables_source_type_check
      CHECK (source_type IN ('operational', 'opening'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payables_opening_fields_check') THEN
    ALTER TABLE payables ADD CONSTRAINT payables_opening_fields_check
      CHECK (source_type <> 'opening'
             OR (as_of_date IS NOT NULL AND opening_reason IS NOT NULL AND lab_order_id IS NULL AND amount_minor > 0));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payables_opening_idx ON payables (party_id) WHERE source_type = 'opening';

CREATE TABLE IF NOT EXISTS payable_adjustments (
  id          SERIAL PRIMARY KEY,
  payable_id  INTEGER     NOT NULL REFERENCES payables(id) ON DELETE RESTRICT,
  delta_minor BIGINT      NOT NULL CHECK (delta_minor <> 0),
  reason      TEXT        NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS payable_adjustments_payable_idx ON payable_adjustments (payable_id);

CREATE TABLE IF NOT EXISTS party_opening_advances (
  id                SERIAL PRIMARY KEY,
  party_id          INTEGER       NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
  currency          TEXT          NOT NULL CHECK (currency IN ('YER', 'SAR', 'USD')),
  amount_minor      BIGINT        NOT NULL CHECK (amount_minor > 0),
  exchange_rate     NUMERIC(18,6) NOT NULL CHECK (exchange_rate > 0),
  base_amount_minor BIGINT        NOT NULL,
  as_of_date        DATE          NOT NULL,
  reference         TEXT,
  note              TEXT,
  reason            TEXT          NOT NULL CHECK (length(btrim(reason)) >= 3),
  created_by        TEXT          NOT NULL,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  voided_at         TIMESTAMPTZ,
  voided_by         TEXT,
  void_reason       TEXT,
  CONSTRAINT party_opening_advances_void_check
    CHECK ((voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
        OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(btrim(void_reason)) >= 3))
);
CREATE INDEX IF NOT EXISTS party_opening_advances_party_idx ON party_opening_advances (party_id);

CREATE OR REPLACE FUNCTION aqlan_opening_payable_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source_type = 'opening' THEN
      RAISE EXCEPTION 'الرصيد الافتتاحي للجهة لا يُحذف — يُصحَّح بتصحيحٍ مسبَّب.';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.source_type = 'opening' OR NEW.source_type = 'opening' THEN
    IF NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.party_id IS DISTINCT FROM OLD.party_id
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
       OR NEW.base_amount_minor IS DISTINCT FROM OLD.base_amount_minor
       OR NEW.as_of_date IS DISTINCT FROM OLD.as_of_date
       OR NEW.opening_reason IS DISTINCT FROM OLD.opening_reason THEN
      RAISE EXCEPTION 'الرصيد الافتتاحي للجهة لا يُعدَّل صامتًا — يُصحَّح بتصحيحٍ مسبَّب.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payables_opening_guard ON payables;
CREATE TRIGGER payables_opening_guard BEFORE UPDATE OR DELETE ON payables
  FOR EACH ROW EXECUTE FUNCTION aqlan_opening_payable_guard();

CREATE OR REPLACE FUNCTION aqlan_payable_adjustments_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'تصحيحات الأرصدة الافتتاحية سجلٌّ إلحاقي — لا تُعدَّل ولا تُحذف.';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payable_adjustments_append_only ON payable_adjustments;
CREATE TRIGGER payable_adjustments_append_only BEFORE UPDATE OR DELETE ON payable_adjustments
  FOR EACH ROW EXECUTE FUNCTION aqlan_payable_adjustments_append_only();

CREATE OR REPLACE FUNCTION aqlan_opening_advance_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'الرصيد المقدَّم الافتتاحي لا يُحذف — يُلغى بسبب.';
  END IF;
  IF OLD.voided_at IS NOT NULL
     OR NEW.party_id IS DISTINCT FROM OLD.party_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
     OR NEW.base_amount_minor IS DISTINCT FROM OLD.base_amount_minor
     OR NEW.as_of_date IS DISTINCT FROM OLD.as_of_date
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'الرصيد المقدَّم الافتتاحي لا يُعدَّل — يُلغى بسببٍ ويُدخل الصحيح.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS party_opening_advances_guard ON party_opening_advances;
CREATE TRIGGER party_opening_advances_guard BEFORE UPDATE OR DELETE ON party_opening_advances
  FOR EACH ROW EXECUTE FUNCTION aqlan_opening_advance_guard();

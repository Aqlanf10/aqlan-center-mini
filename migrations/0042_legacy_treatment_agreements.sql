-- (INV-LEGACY) Pre-system / legacy treatment: the historical agreement (agreed, paid before the system, remaining at
-- system start, cutoff date, currency, who/when), its plan item and case, and its link to the opening-balance history row.
-- Additive only: one new table with indexes and an append-only guard (void transition only); no existing table is touched.
-- Body must remain byte-for-byte equal to LEGACY_TREATMENT_SQL after these comments.
CREATE TABLE IF NOT EXISTS legacy_treatment_agreements (
  id                       SERIAL      PRIMARY KEY,
  patient_id               INTEGER     NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  plan_item_id             INTEGER     NOT NULL REFERENCES plan_items(id),
  case_id                  INTEGER     REFERENCES clinical_cases(id),
  service_id               INTEGER     NOT NULL REFERENCES services(id),
  service_name             TEXT        NOT NULL,
  specialty                TEXT        NOT NULL,
  tooth_code               SMALLINT,
  currency                 TEXT        NOT NULL CHECK (currency IN ('YER', 'SAR', 'USD')),
  agreed_minor             BIGINT      NOT NULL CHECK (agreed_minor > 0),
  previously_paid_minor    BIGINT      NOT NULL CHECK (previously_paid_minor >= 0),
  remaining_minor          BIGINT      NOT NULL CHECK (remaining_minor >= 0),
  historical_as_of         DATE        NOT NULL,
  opening_effect           TEXT        NOT NULL CHECK (opening_effect IN ('none', 'created', 'increased')),
  opening_history_id       INTEGER     REFERENCES patient_opening_balance_history(id),
  note                     TEXT,
  idempotency_key          TEXT,
  idempotency_request_hash TEXT,
  created_by               TEXT        NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status                   TEXT        NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'void')),
  voided_by                TEXT,
  voided_at                TIMESTAMPTZ,
  void_reason              TEXT,
  void_opening_history_id  INTEGER     REFERENCES patient_opening_balance_history(id),
  CONSTRAINT legacy_treatment_agreements_amounts_check
    CHECK (previously_paid_minor <= agreed_minor AND remaining_minor = agreed_minor - previously_paid_minor),
  CONSTRAINT legacy_treatment_agreements_opening_check
    CHECK ((remaining_minor = 0 AND opening_effect = 'none' AND opening_history_id IS NULL)
        OR (remaining_minor > 0 AND opening_effect <> 'none' AND opening_history_id IS NOT NULL)),
  CONSTRAINT legacy_treatment_agreements_void_check
    CHECK ((status = 'live' AND voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL
            AND void_opening_history_id IS NULL)
        OR (status = 'void' AND voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL
            AND length(btrim(void_reason)) >= 3))
);
CREATE UNIQUE INDEX IF NOT EXISTS legacy_treatment_agreements_idempotency_uniq
  ON legacy_treatment_agreements (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS legacy_treatment_agreements_live_scope_uniq
  ON legacy_treatment_agreements (patient_id, service_id, COALESCE(tooth_code, 0)) WHERE status = 'live';
CREATE UNIQUE INDEX IF NOT EXISTS legacy_treatment_agreements_live_item_uniq
  ON legacy_treatment_agreements (plan_item_id) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS legacy_treatment_agreements_patient_idx
  ON legacy_treatment_agreements (patient_id, id);
CREATE INDEX IF NOT EXISTS legacy_treatment_agreements_case_idx
  ON legacy_treatment_agreements (case_id) WHERE case_id IS NOT NULL;

CREATE OR REPLACE FUNCTION aqlan_legacy_treatment_agreement_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM patients WHERE id = OLD.patient_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'legacy_treatment_agreements is append-only: void the agreement instead of deleting it';
  END IF;
  IF OLD.status = 'live' AND NEW.status = 'void'
     AND (to_jsonb(NEW) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason', 'void_opening_history_id'])
       = (to_jsonb(OLD) - ARRAY['status', 'voided_by', 'voided_at', 'void_reason', 'void_opening_history_id']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'legacy_treatment_agreements is append-only: only a live agreement may be voided';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER legacy_treatment_agreements_guard
  BEFORE UPDATE OR DELETE ON legacy_treatment_agreements
  FOR EACH ROW EXECUTE FUNCTION aqlan_legacy_treatment_agreement_guard();

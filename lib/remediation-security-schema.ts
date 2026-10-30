/**
 * Additive security columns, audited owner paper-archive override guard,
 * audit_log TRUNCATE protection, party GL account defaults, HTTP idempotency table, and hot FK indexes.
 */
export const REMEDIATION_SECURITY_AND_INDEXES_SQL = String.raw`-- 0091: Remediation security columns, owner paper-archive override guard, audit TRUNCATE guard, GL party defaults, HTTP idempotency table, and hot FK indexes.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS portal_secret_version INTEGER NOT NULL DEFAULT 0 CHECK (portal_secret_version >= 0);

UPDATE users
SET is_owner = TRUE
WHERE id = (SELECT MIN(id) FROM users WHERE role = 'admin' AND is_active = TRUE)
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = TRUE);

UPDATE parties
SET expense_account_code = CASE kind
      WHEN 'supplier' THEN '5201'
      WHEN 'doctor'   THEN '5301'
      WHEN 'employee' THEN '5401'
      ELSE expense_account_code
    END,
    payable_account_code = CASE kind
      WHEN 'supplier' THEN '2105'
      WHEN 'doctor'   THEN '2106'
      WHEN 'employee' THEN '2107'
      ELSE payable_account_code
    END
WHERE kind IN ('supplier', 'doctor', 'employee')
  AND expense_account_code = '5101'
  AND payable_account_code = '2101';

CREATE TABLE IF NOT EXISTS http_idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL,
  actor TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'completed')),
  status_code INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (scope, actor, idempotency_key)
);

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

CREATE OR REPLACE FUNCTION reject_ortho_strategy_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND coalesce(current_setting('aqlan.patient_merge_active', true), '') = 'on'
     AND (to_jsonb(NEW) - 'patient_id') = (to_jsonb(OLD) - 'patient_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ortho_strategy_revisions are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION reject_ortho_assessment_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND coalesce(current_setting('aqlan.patient_merge_active', true), '') = 'on'
     AND (to_jsonb(NEW) - 'patient_id') = (to_jsonb(OLD) - 'patient_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ortho_assessment_revisions are immutable';
END;
$$;

CREATE OR REPLACE FUNCTION aqlan_patient_number_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.patient_number IS NOT DISTINCT FROM OLD.patient_number THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'patient numbering requires READ COMMITTED' USING ERRCODE='25000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('patient_numbering')) THEN
    RAISE EXCEPTION 'patient numbering busy; refresh and retry' USING ERRCODE='55P03';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF EXISTS(SELECT 1 FROM patients p WHERE p.id<>NEW.id AND aqlan_patient_number_key(p.patient_number)=aqlan_patient_number_key(NEW.patient_number))
      OR (
        EXISTS(SELECT 1 FROM retired_patient_numbers r WHERE aqlan_patient_number_key(r.patient_number)=aqlan_patient_number_key(NEW.patient_number))
        AND NOT (
          coalesce(current_setting('aqlan.owner_paper_override', true), '') = 'on'
          AND aqlan_patient_number_numeric(NEW.patient_number) BETWEEN 1 AND 6999
        )
      ) THEN
      RAISE EXCEPTION 'patient number is already used or retired' USING ERRCODE='23505';
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    INSERT INTO retired_patient_numbers(patient_number,patient_id) VALUES(OLD.patient_number,OLD.id) ON CONFLICT DO NOTHING;
    IF TG_OP='UPDATE' THEN NEW.patient_number_version := OLD.patient_number_version+1; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION aqlan_legacy_coverage_site_valid(
  category TEXT, mode TEXT, anchor SMALLINT, teeth SMALLINT[], scope TEXT, surfaces TEXT
) RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    teeth IS NOT NULL
    AND cardinality(teeth) BETWEEN 0 AND 32
    AND teeth = ARRAY(SELECT DISTINCT tooth FROM unnest(teeth) AS tooth ORDER BY tooth)
    AND NOT EXISTS (SELECT 1 FROM unnest(teeth) AS tooth WHERE tooth IS NULL
      OR NOT ((tooth / 10 BETWEEN 1 AND 4 AND tooth % 10 BETWEEN 1 AND 8)
           OR (tooth / 10 BETWEEN 5 AND 8 AND tooth % 10 BETWEEN 1 AND 5)))
    AND CASE
      WHEN category IN ('rct', 'post', 'implant', 'extraction', 'surgery') THEN
        mode = 'per_tooth_episode' AND anchor IS NOT NULL AND teeth = ARRAY[anchor]
        AND scope IS NULL AND surfaces IS NULL
      WHEN category IN ('crown', 'veneer', 'bridge') THEN
        mode = 'multi_tooth_episode' AND anchor IS NOT NULL AND anchor = ANY(teeth)
        AND scope IS NULL AND surfaces IS NULL
      WHEN category IN ('filling', 'sealant') THEN
        mode = 'tooth_surfaces' AND anchor IS NOT NULL AND teeth = ARRAY[anchor] AND scope IS NULL
        AND (surfaces IS NULL OR (length(surfaces) BETWEEN 1 AND 6
          AND surfaces !~ '[^MDOIBL]' AND surfaces ~ '^M?D?O?I?B?L?$'))
      WHEN category = 'ortho' THEN
        mode = 'arch' AND anchor IS NULL AND cardinality(teeth) = 0
        AND scope IN ('upper', 'lower', 'both') AND surfaces IS NULL
      WHEN category = 'cleaning' THEN
        mode = 'region' AND surfaces IS NULL AND (
          (anchor IS NOT NULL AND teeth = ARRAY[anchor] AND scope IS NULL)
          OR (anchor IS NULL AND cardinality(teeth) = 0 AND scope IN ('upper', 'lower', 'full_mouth')))
      WHEN category = 'whitening' THEN
        mode = 'none' AND anchor IS NULL AND cardinality(teeth) = 0
        AND scope = 'full_mouth' AND surfaces IS NULL
      ELSE FALSE
    END, FALSE);
$$ LANGUAGE SQL IMMUTABLE;

CREATE INDEX IF NOT EXISTS idx_visits_patient_id ON visits(patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_appointment_id ON visits(appointment_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_reversal_of_id ON payments(reversal_of_id);
CREATE INDEX IF NOT EXISTS idx_invoices_plan_id ON invoices(plan_id);
`;

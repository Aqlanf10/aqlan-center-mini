-- (P3-8) Outbound patient referrals (letter to a surgeon/specialist, closed with an outcome).
-- Body must remain byte-for-byte equal to PATIENT_REFERRALS_SQL after these comments.
CREATE TABLE IF NOT EXISTS patient_referrals (
  id              SERIAL      PRIMARY KEY,
  patient_id      INTEGER     NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  to_name         TEXT        NOT NULL CHECK (length(btrim(to_name)) > 0),
  to_specialty    TEXT        NOT NULL,
  reason          TEXT        NOT NULL CHECK (length(btrim(reason)) > 0),
  teeth           TEXT,
  urgency         TEXT        NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine', 'soon', 'urgent')),
  status          TEXT        NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'completed', 'cancelled')),
  outcome_note    TEXT,
  doctor_party_id INTEGER     REFERENCES parties(id) ON DELETE RESTRICT,
  created_by      TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_by       TEXT,
  closed_at       TIMESTAMPTZ,
  CHECK ((status = 'sent') = (closed_at IS NULL)),
  CHECK (status <> 'cancelled' OR length(btrim(coalesce(outcome_note, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS patient_referrals_patient_idx ON patient_referrals (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS patient_referrals_open_idx ON patient_referrals (created_at) WHERE status = 'sent';

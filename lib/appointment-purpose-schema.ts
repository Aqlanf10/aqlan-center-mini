/** Byte-identical registered 0095 SQL. Keep in sync with migrations/0095_appointment_purpose_provenance.sql; source parity is a release gate. */
export const APPOINTMENT_PURPOSE_PROVENANCE_SQL = `-- Explicit appointment-purpose provenance only. Legacy appointments have no row.
-- Review gate: composite ownership FKs protect the recorded patient/plan/planned
-- visit tuple; live appointments.planned_visit_id remains a separate workflow link.
-- This file is versioned DDL, never injected into ensureSchema's inline block.

-- PostgreSQL requires exactly matching unique referenced column sets for the
-- patient/plan/visit ownership FKs below. The existing id PKs remain canonical.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_purpose_identity_uniq UNIQUE (id, patient_id);
ALTER TABLE treatment_plans
  ADD CONSTRAINT treatment_plans_purpose_identity_uniq UNIQUE (id, patient_id);
ALTER TABLE planned_visits
  ADD CONSTRAINT planned_visits_purpose_identity_uniq UNIQUE (id, patient_id, plan_id);

CREATE TABLE appointment_purpose_provenance (
  appointment_id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN
    ('consultation', 'start_treatment', 'continue_session', 'try_in', 'delivery', 'follow_up')),
  source_plan_id INTEGER,
  source_planned_visit_id INTEGER,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  recorded_by TEXT NOT NULL CHECK (length(btrim(recorded_by)) BETWEEN 1 AND 200),
  -- A committed direct booking carries its own immutable recovery receipt.
  -- Planned/rebook rows never reuse a direct command key.
  command_id UUID,
  command_hash TEXT,
  actor_user_id INTEGER,
  CONSTRAINT appointment_purpose_command_shape CHECK (
    (purpose IN ('consultation', 'start_treatment')
      AND command_id IS NOT NULL AND command_hash IS NOT NULL
      AND command_hash ~ '^[0-9a-f]{64}$'
      AND actor_user_id IS NOT NULL)
    OR
    (purpose IN ('continue_session', 'try_in', 'delivery', 'follow_up')
      AND command_id IS NULL AND command_hash IS NULL AND actor_user_id IS NULL)
  ),
  CONSTRAINT appointment_purpose_command_uniq UNIQUE (command_id),
  CONSTRAINT appointment_purpose_actor_fk FOREIGN KEY (actor_user_id)
    REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT appointment_purpose_source_shape CHECK (
    (purpose IN ('consultation', 'start_treatment')
      AND source_plan_id IS NULL AND source_planned_visit_id IS NULL)
    OR
    (purpose IN ('continue_session', 'try_in', 'delivery', 'follow_up')
      AND source_plan_id IS NOT NULL AND source_planned_visit_id IS NOT NULL)
  ),
  CONSTRAINT appointment_purpose_patient_fk FOREIGN KEY (patient_id)
    REFERENCES patients(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT appointment_purpose_appointment_owner_fk FOREIGN KEY (appointment_id, patient_id)
    REFERENCES appointments(id, patient_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT appointment_purpose_plan_owner_fk FOREIGN KEY (source_plan_id, patient_id)
    REFERENCES treatment_plans(id, patient_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT appointment_purpose_visit_owner_plan_fk FOREIGN KEY
    (source_planned_visit_id, patient_id, source_plan_id)
    REFERENCES planned_visits(id, patient_id, plan_id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX appointment_purpose_patient_time_idx
  ON appointment_purpose_provenance (patient_id, recorded_at DESC, appointment_id DESC);
CREATE INDEX appointment_purpose_plan_time_idx
  ON appointment_purpose_provenance (source_plan_id, recorded_at DESC)
  WHERE source_plan_id IS NOT NULL;

-- The row never becomes an editable classification. Rebooking inserts a fresh
-- row for the replacement and leaves the previous appointment's source intact.
-- Empty-only TRUNCATE cooperates with the protected-history clinic reset while
-- rejecting any path that would erase actual recorded provenance.
CREATE FUNCTION aqlan_appointment_purpose_immutable() RETURNS TRIGGER AS $$
DECLARE has_rows BOOLEAN;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', TG_TABLE_SCHEMA, TG_TABLE_NAME)
      INTO has_rows;
    IF NOT has_rows THEN RETURN NULL; END IF;
  END IF;
  RAISE EXCEPTION 'appointment purpose provenance is immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_purpose_immutable
  BEFORE UPDATE OR DELETE ON appointment_purpose_provenance
  FOR EACH ROW EXECUTE FUNCTION aqlan_appointment_purpose_immutable();
CREATE TRIGGER appointment_purpose_no_nonempty_truncate
  BEFORE TRUNCATE ON appointment_purpose_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION aqlan_appointment_purpose_immutable();
`;
export const APPOINTMENT_PURPOSE_PROVENANCE_SHA256 = "149a8d3c1f03cb4008d99e2017a341f33c0f1286dbcba8cdb4f16473e2ffa62a";

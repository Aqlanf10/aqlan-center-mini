-- Patient-scoped appointment keyset reads; no row changes or additional predicate.
-- Ordinary CREATE INDEX runs in the migration transaction and can block writes.
CREATE INDEX appointments_patient_history_idx
  ON appointments (patient_id, scheduled_date, scheduled_time, id);

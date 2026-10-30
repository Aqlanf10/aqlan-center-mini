/** Nullable snapshot: legacy prescriptions are not relabelled or backfilled. */
export const PRESCRIBING_DOCTOR_SNAPSHOT_SQL = `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS prescribing_doctor_name TEXT;
`;

/** Nullable snapshot: legacy prescriptions are not relabelled or backfilled. */
export const PRESCRIBING_DOCTOR_SNAPSHOT_SQL = `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS prescribing_doctor_name TEXT;
`;

/** Separate identity snapshot; never repurpose the historical issuer field. */
export const PRESCRIBING_DOCTOR_IDENTITY_SQL = `ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS prescribing_doctor_party_id INTEGER;
`;

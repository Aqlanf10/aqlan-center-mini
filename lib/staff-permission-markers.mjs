/** Shared reserved fields; presence never permits legacy fallback. */
export const STAFF_PERMISSION_ENVELOPE_FIELDS = Object.freeze(["schemaVersion", "revision", "confirmation", "patientScope", "appointmentScope", "grants"]);

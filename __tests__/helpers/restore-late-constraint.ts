/** Writer-shaped SQL which duplicates a synthetic patient imported earlier. */
export const SYNTHETIC_DUPLICATE_PATIENT_ID = 75000;
export const SYNTHETIC_DUPLICATE_PATIENT_SQL =
  `INSERT INTO patients ("id", "patient_number", "full_name") VALUES (${SYNTHETIC_DUPLICATE_PATIENT_ID}, 'SYN-ROLLBACK-PROBE', 'Synthetic duplicate patient');`;

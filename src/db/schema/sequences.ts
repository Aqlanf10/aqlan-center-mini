import { pgSequence } from "drizzle-orm/pg-core";

/**
 * PostgreSQL sequence backing human-readable patient file numbers (P-000001…).
 *
 * A sequence guarantees uniqueness under concurrency — unlike
 * SELECT MAX(file_number) + 1, two simultaneous inserts can never draw the
 * same number. The UUID primary key stays internal; the file number is a
 * unique display/lookup key only.
 */
export const patientFileNumberSeq = pgSequence("patient_file_number_seq", {
  startWith: 1,
});

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

/**
 * Sequence backing lab case numbers (LC-YYYY-NNNNNN). Global sequence; the
 * year is the case creation year in Asia/Aden — uniqueness is guaranteed by
 * the unique index on case_number.
 */
export const labCaseNumberSeq = pgSequence("lab_case_number_seq", {
  startWith: 1,
});

/**
 * Sequence backing purchase invoice numbers (PINV-YYYY-NNNNNN).
 */
export const purchaseInvoiceNumberSeq = pgSequence(
  "purchase_invoice_number_seq",
  {
    startWith: 1,
  }
);

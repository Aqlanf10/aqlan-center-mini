import { describe, expect, it } from "vitest";
import { RESET_SEQUENCES } from "../lib/clinic-reset";
import { PATIENT_NUMBER_SQL, paddedSequenceSql } from "../lib/document-numbers";

/**
 * P0-A archival numbering fence.
 *
 * The old main branch reset patient_number_seq to 1. Staging deliberately
 * excludes it: the patient archive ID is durable even across an owner reset.
 * This is a fast, synthetic regression guard, NOT a PostgreSQL restore drill.
 */
describe("patient archive IDs survive clinic reset", () => {
  it("never rewinds the patient sequence when resetting test records", () => {
    expect(RESET_SEQUENCES).not.toContain("patient_number_seq");
  });

  it("generates patient numbers from the durable sequence rather than a financial document counter", () => {
    expect(PATIENT_NUMBER_SQL).toBe(`'P-' || ${paddedSequenceSql("patient_number_seq")}`);
    expect(PATIENT_NUMBER_SQL).toContain("nextval('patient_number_seq')");
    expect(PATIENT_NUMBER_SQL).not.toMatch(/invoice_number_seq|receipt_number_seq|voucher_number_seq/);
  });

  it("does not truncate archive IDs after five digits", () => {
    expect(paddedSequenceSql("patient_number_seq")).toContain("regexp_replace");
    expect(paddedSequenceSql("patient_number_seq")).toContain("LPAD(nextval('patient_number_seq')::text, 20, '0')");
    expect(paddedSequenceSql("patient_number_seq")).not.toContain("LPAD(nextval('patient_number_seq')::text, 5,");
  });
});

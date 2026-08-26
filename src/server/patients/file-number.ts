import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

/**
 * Concurrency-safe human-readable patient file numbers (P-000001…).
 *
 * Backed by the PostgreSQL sequence `patient_file_number_seq` created in
 * migration 0001. `nextval` is atomic: two simultaneous requests can never
 * draw the same number (unlike SELECT MAX(...) + 1).
 */

export function formatFileNumber(nextValue: number | string): string {
  const numeric =
    typeof nextValue === "string" ? Number.parseInt(nextValue, 10) : nextValue;
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`Invalid file number sequence value: ${nextValue}`);
  }
  return `P-${String(numeric).padStart(6, "0")}`;
}

/** Draw the next file number from the database sequence. */
export async function nextFileNumber(): Promise<string> {
  const result = await db.execute<{ value: string | number }>(
    sql`SELECT nextval('patient_file_number_seq') AS value`
  );
  const rows = (result as unknown as { rows: { value: string | number }[] })
    .rows;
  const value = rows?.[0]?.value;
  if (value === undefined) {
    throw new Error("patient_file_number_seq returned no value");
  }
  return formatFileNumber(value);
}

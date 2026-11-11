import type { CaseParticipant, CaseParticipation } from "./commission";

/**
 * The case-participation decisions in force at the end of a clinic day, by case: the newest
 * decision of each case made on or before that day. A `void` head means the case is no longer
 * shared (absent from the map). A report for an earlier period therefore keeps the split that was
 * in force then. Kept free of `./db` so the commission report can read it without an import cycle.
 */
export async function loadCaseParticipationsAt(
  asOfClinicDate: string,
  runner: { query: <R>(sql: string, values?: unknown[]) => Promise<{ rows: R[] }> },
  clinicTimeZone: string,
): Promise<Map<number, CaseParticipation>> {
  const { rows } = await runner.query<{ case_id: number; status: "approved" | "pending" | "void"; participants: CaseParticipant[] }>(
    `SELECT DISTINCT ON (p.case_id) p.case_id, p.status, p.participants
       FROM commission_case_participations p
      WHERE (p.decided_at AT TIME ZONE $1)::date <= $2::date
      ORDER BY p.case_id, p.id DESC`, [clinicTimeZone, asOfClinicDate]);
  const result = new Map<number, CaseParticipation>();
  for (const row of rows) {
    if (row.status === "void") continue;
    result.set(row.case_id, { caseId: row.case_id, status: row.status, participants: row.participants });
  }
  return result;
}

import type { DbClient } from "./db";
/** Durable monotonic responsibility witness. Settings emits this event in the
 * same row-locked transaction as the owner change, even for A→B→A. Financial
 * correction never changes current responsibility. No timestamp/row-value ABA. */
export async function readResponsibilityRevision(
  client: Pick<DbClient, "query">, patientId: number, clinicalCaseIds: number[], orthoCaseId: number | null,
): Promise<string> {
  const { rows } = await client.query<{ revision: string }>(
    `SELECT COALESCE(MAX(id), 0)::text AS revision FROM audit_log
     WHERE action = 'case.responsibility_change' AND entity = 'patient' AND entity_id = $1::text
       AND ((details #>> '{target,kind}' = 'clinical' AND details #>> '{target,sourceId}' = ANY($2::text[]))
         OR (details #>> '{target,kind}' = 'ortho' AND details #>> '{target,sourceId}' = $3::text))`,
    [String(patientId), clinicalCaseIds.map(String), orthoCaseId === null ? null : String(orthoCaseId)],
  );
  if (!rows[0] || !/^\d+$/.test(rows[0].revision)) throw new Error("Responsibility history could not be verified");
  return rows[0].revision;
}

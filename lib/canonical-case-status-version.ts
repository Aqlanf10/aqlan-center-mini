import "server-only";
import { createHash } from "node:crypto";
/** Current physical clinical-case version, not durable request idempotency. */
export function clinicalCaseStatusVersion(row: { id: number; patientId: number; specialty: string; orthoCaseId: number | null; status: string; outcome: string | null; completedAt: string | null; versionXmin: string; versionTid: string }): string {
  return createHash("sha256").update(JSON.stringify([row.id,row.patientId,row.specialty,row.orthoCaseId,row.status,row.outcome,row.completedAt,row.versionXmin,row.versionTid])).digest("hex");
}

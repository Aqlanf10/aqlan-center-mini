import "server-only";
import { createHash } from "node:crypto";
/** Opaque current-row witness, not authorization or a durable request receipt. */
export function clinicalProblemStatusVersion(row: { id: number; patientId: number; status: string; resolvedAt: string | null; resolvedBy: string | null; versionXmin: string; versionTid: string }): string {
  return createHash("sha256").update(JSON.stringify([row.id,row.patientId,row.status,row.resolvedAt,row.resolvedBy,row.versionXmin,row.versionTid])).digest("hex");
}

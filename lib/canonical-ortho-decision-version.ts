import { createHash } from "node:crypto";
export interface OrthoDecisionObservation {
  adjustmentId: number; patientId: number; caseId: number;
  adjustmentXmin: string; adjustmentTid: string; caseXmin: string; caseTid: string;
}
/** Opaque row observation, not a permanent command receipt or patient-content hash. */
export function orthoDecisionVersion(row: OrthoDecisionObservation): string {
  return createHash("sha256").update(JSON.stringify(["ortho-decision-v1", row.adjustmentId, row.patientId, row.caseId,
    row.adjustmentXmin, row.adjustmentTid, row.caseXmin, row.caseTid])).digest("hex");
}

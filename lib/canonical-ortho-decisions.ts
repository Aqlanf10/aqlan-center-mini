import "server-only";
import { listPendingOrthoDecisionSummariesWith } from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { CanonicalPatientReadRefusal } from "./canonical-patient-reads";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { isCanonicalOrthoDecisions, type CanonicalOrthoDecisions } from "./canonical-ortho-decisions-projection";
export function canonicalOrthoDecisionQuery(params: URLSearchParams) {
  if ([...params.keys()].length) throw new CanonicalPatientReadRefusal("invalid_patient_query", "قائمة المراجعة لا تقبل مرشحات إضافية.");
}
export function readCanonicalOrthoDecisions(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(session, "read:ortho.decisions", async (q, scope): Promise<CanonicalOrthoDecisions> => {
    const source = await listPendingOrthoDecisionSummariesWith(q, scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null);
    const out: CanonicalOrthoDecisions = { projection: "ortho-pending-decisions", hasMore: source.hasMore, limit: 300,
      pending: source.rows.map(row => ({ adjustmentId: row.adjustmentId, patientId: row.patientId, patientName: row.patientName, doneOn: row.doneOn, doctorName: row.doctorName, legacy: row.legacy })) };
    if (!isCanonicalOrthoDecisions(out)) throw new Error("STAFF_READ_READ_FAILED");
    return out;
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}

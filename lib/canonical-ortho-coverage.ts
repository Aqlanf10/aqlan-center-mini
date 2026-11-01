import "server-only";
import { CanonicalPatientReadRefusal, readCanonicalPatientRecord } from "./canonical-patient-reads";
import { canonicalOrthoCaseId } from "./canonical-ortho-reads";
import { readFollowupCoverageSnapshotWith } from "./ortho-followup-coverage-db";
import type { VerifiedDurableSession } from "./staff-durable-session";
import type { CanonicalOrthoCoverage } from "./canonical-ortho-coverage-projection";

export function canonicalCoverageQuery(raw: string, params: URLSearchParams) {
  const caseId = canonicalOrthoCaseId(raw, new URLSearchParams());
  if ([...params.keys()].some(key => key !== "patientId") || params.getAll("patientId").length !== 1)
    throw new CanonicalPatientReadRefusal("invalid_patient_query", "طلب نطاق المتابعات غير صالح.");
  return { caseId, patientId: canonicalOrthoCaseId(params.get("patientId")!, new URLSearchParams()) };
}
export function readCanonicalOrthoCoverage(session: VerifiedDurableSession, patientId: number, caseId: number) {
  return readCanonicalPatientRecord(session, "read:ortho.coverage", patientId, async (q, scope): Promise<CanonicalOrthoCoverage> => {
    const found = (await q.query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2", [caseId, patientId])).rows[0];
    if (!found) throw new CanonicalPatientReadRefusal("patient_not_found", "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
    const saved = await readFollowupCoverageSnapshotWith(q, patientId, caseId), head = saved.current;
    return { projection: "ortho-followup-coverage", patientId, orthoCaseId: caseId, enabled: saved.enabled, applicable: saved.applicable,
      current: head ? { id: head.id, version: head.version, decision: head.decision, reason: head.reason, createdAt: head.createdAt, createdBy: head.createdBy } : null,
      invoiceSources: scope.granted("finance.invoices.view")
        ? { state: "allowed", items: saved.sources.map(s => ({ invoiceId: s.invoiceId, invoiceNumber: s.invoiceNumber, serviceName: s.serviceName })) }
        : { state: "restricted" } };
  }, 1024 * 1024);
}

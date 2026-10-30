import "server-only";
import { CLINIC_TIME_ZONE, getOrthoClinicalDetailWith, listOrthoCaseSummariesWith } from "./db";
import { CanonicalPatientReadRefusal, readCanonicalPatientRecord } from "./canonical-patient-reads";
import { runCanonicalReadSnapshot, type CanonicalSnapshotQuery, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import type { OrthoCaseSummaryFeed } from "./ortho";
import { clinicDateString } from "./schedule";

/** The only admitted query is the existing optional patientId. No caller-selected
 * doctor/scope, hidden financial filter, or fall-through to legacy readers. */
export function canonicalOrthoPatientFilter(params: URLSearchParams): number | null {
  const values = params.getAll("patientId");
  if ([...params.keys()].some(key => key !== "patientId") || values.length > 1
    || (values.length && (!/^[1-9]\d*$/.test(values[0]) || !Number.isSafeInteger(Number(values[0]))))) {
    throw new CanonicalPatientReadRefusal("invalid_patient_query", "رقم المريض أو مرشح القائمة غير صالح.");
  }
  return values.length ? Number(values[0]) : null;
}

export async function readCanonicalOrthoCases(session: VerifiedDurableSession, patientId: number | null): Promise<OrthoCaseSummaryFeed> {
  const read = async (query: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope): Promise<OrthoCaseSummaryFeed> => ({
    ...await listOrthoCaseSummariesWith(query, patientId, scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null),
    today: clinicDateString(new Date(), CLINIC_TIME_ZONE), projection: "case-summary",
  });
  // This per-patient entrance proves existence and membership in the SAME snapshot:
  // outside = missing, including a file that has no ortho case yet.
  return patientId === null
    ? runCanonicalReadSnapshot(session, "read:ortho.cases", read, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 })
    : readCanonicalPatientRecord(session, "read:ortho.cases", patientId, read, 1024 * 1024);
}

/** No query-selected expansions. Independent surfaces stay outside this contract. */
export function canonicalOrthoCaseId(raw: string, params: URLSearchParams): number {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647 || [...params.keys()].length) {
    throw new CanonicalPatientReadRefusal("invalid_patient_query", "رقم الحالة أو طلب التفاصيل غير صالح.");
  }
  return Number(raw);
}
export async function readCanonicalOrthoCase(session: VerifiedDurableSession, caseId: number) {
  return runCanonicalReadSnapshot(session, "read:ortho.case", async (query, scope) => {
    const result = await getOrthoClinicalDetailWith(query, caseId,
      scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null,
      clinicDateString(new Date(), CLINIC_TIME_ZONE));
    if (!result) throw new CanonicalPatientReadRefusal("patient_not_found", "الحالة غير موجودة ضمن مرضاك.");
    return result;
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 * 1024 });
}

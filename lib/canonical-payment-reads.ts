import "server-only";
import { CLINIC_TIME_ZONE, listPaymentsByDateWith, patientIdsInDoctorScopeWith } from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { clinicDateString } from "./schedule";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The day's receipts on the canonical runtime (M2 slice 90a; owner decision G4-4:
 * payments need `finance.payments.view`). One read-only snapshot; the rows only inside the
 * actor's patient scope (`own`: the validated clinician's patients by the list predicate),
 * the same rule as the debtors list (slice 88) and the invoices (G4-8). The body is the
 * legacy one: `{ date, payments }`, the date defaulting to the clinic's today.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export async function readCanonicalDayPayments(session: VerifiedDurableSession, requestedDate: string | null) {
  const date = requestedDate && DATE.test(requestedDate) ? requestedDate : clinicDateString(new Date(), CLINIC_TIME_ZONE);
  return runCanonicalReadSnapshot(session, "read:payments.day", async (query, scope) => {
    let ids: number[] | null = null;
    if (scope.patientScope.kind === "own") ids = await patientIdsInDoctorScopeWith(query, scope.patientScope.clinicianPartyId);
    else if (scope.patientScope.kind !== "all") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    return { date, payments: await listPaymentsByDateWith(query, date, ids) };
  }, { errorPrefix: "STAFF_READ", maxBytes: 4 * 1024 * 1024 });
}

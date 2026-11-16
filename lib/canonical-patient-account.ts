import "server-only";
import {
  CLINIC_TIME_ZONE, computeDebtRowsInSnapshot, getPatientWith, getSettingsWith, listPatientPlansWith, patientIdsInDoctorScopeWith,
  patientLedgerInSnapshot, patientReceiptRemaindersWith, patientReversedInstallmentRecoveriesWith, patientStatementSnapshotOn, type DbClient,
} from "./db";
import { CanonicalPatientReadRefusal, readCanonicalPatientRecord } from "./canonical-patient-reads";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { debtRepaymentWorkspaceInSnapshot } from "./debt-installments-db";
import { CLINIC_BASE_CURRENCY } from "./money";
import { patientStatementDocumentFrom, statementSnapshotOptions } from "./patient-statement-build";
import type { PatientStatementOptions } from "./patient-statement-options";
import { treatmentFinancialReferencesInSnapshot } from "./treatment-financial-context-db";
import { listLegacyBalanceArrangements, listLegacyOpeningPositionsWith } from "./legacy-balance-arrangements-db";
import { readReceiptProvenanceInSnapshot } from "./receipt-provenance-db";
import { buildPatientLedgerPayload } from "./patient-ledger-payload";
import { clinicDateString } from "./schedule";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The patient account on the canonical runtime (M2 slice 88; group 4 design:
 * docs/review/financial-group4-contract-design-20261104.md).
 *
 * `GET /api/patients/[id]/ledger`: `read:patients.ledger` — `finance.patient-ledger.view`
 * inside the patient scope (outside reads like missing) — on one owning snapshot. The body
 * is the legacy payload, computed by the same builder from the same snapshot rows. The
 * legacy role-label switches become grants, never wider:
 *  - receipt remainders (the "correct receipt" control, legacy admin label):
 *    `finance.payments.void` or the protected owner;
 *  - opening-balance controls (legacy admin, or reception "add" by a setting): add and
 *    edit with `finance.opening-balances.manage` (the map's grant for both writes);
 *  - legacy balance-arrangement controls (legacy admin/reception): `finance.legacy.record`.
 * Display flags only; every write route proves its own grant again.
 */
export async function readCanonicalPatientLedger(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.ledger", patientId, async (query, scope) => {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const owner = scope.isProtectedOwner();
    const { invoices, payments, openings } = await patientLedgerInSnapshot(patientId, query as DbClient);
    const plans = await listPatientPlansWith(query, patientId, today);
    const receiptRemaining = owner || scope.granted("finance.payments.void") ? await patientReceiptRemaindersWith(query, patientId) : undefined;
    const legacyBalanceArrangements = await listLegacyBalanceArrangements(patientId, today, false, query as DbClient);
    const legacyOpeningPositions = await listLegacyOpeningPositionsWith(query, patientId);
    const installmentRecovery = await patientReversedInstallmentRecoveriesWith(query, patientId);
    const receiptProvenance = await readReceiptProvenanceInSnapshot(query, payments.map(payment => payment.id));
    const manageOpenings = owner || scope.granted("finance.opening-balances.manage");
    return {
      clinicTimeZone: CLINIC_TIME_ZONE,
      ...buildPatientLedgerPayload({ patientId, invoices, payments, openings, plans }),
      ...(receiptRemaining ? { receiptRemaining } : {}),
      receiptProvenance,
      openingAccess: { add: manageOpenings, edit: manageOpenings },
      legacyBalanceArrangements,
      legacyOpeningPositions,
      installmentRecovery,
      legacyArrangementAccess: { manage: owner || scope.granted("finance.legacy.record") },
    };
  }, 4 * 1024 * 1024);
}

/** `GET /api/patients/[id]/treatment-financial-context`: the invoice, receipt and agreement
 * references of the patient's treatments, on the same snapshot (`read:patients.ledger`). */
export async function readCanonicalTreatmentFinancialContext(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.ledger", patientId, async query => {
    const result = await treatmentFinancialReferencesInSnapshot(query, patientId);
    if (!result) throw new CanonicalPatientReadRefusal("patient_not_found", "المريض غير موجود.");
    return result;
  }, 4 * 1024 * 1024);
}

/** `GET /api/patients/[id]/statement`: the patient statement document (print, export and
 * share payload) from one snapshot, the same checks and assembly as the legacy loader. */
export async function readCanonicalPatientStatement(session: VerifiedDurableSession, patientId: number, options: PatientStatementOptions) {
  return readCanonicalPatientRecord(session, "read:patients.ledger", patientId, async query => {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const patient = await getPatientWith(query, patientId);
    if (!patient) throw new CanonicalPatientReadRefusal("patient_not_found", "المريض غير موجود.");
    const settings = await getSettingsWith(query);
    const snapshot = await patientStatementSnapshotOn(query as DbClient, patientId, today, statementSnapshotOptions(options));
    return patientStatementDocumentFrom(patientId, patient, settings, snapshot, options, today);
  }, 4 * 1024 * 1024);
}

/** `GET /api/patients/[id]/legacy-balance-arrangement`: the active arrangements of the
 * previous balance; the manage control with `finance.legacy.record` (legacy admin/reception). */
export async function readCanonicalLegacyBalanceArrangements(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.ledger", patientId, async (query, scope) => ({
    arrangements: await listLegacyBalanceArrangements(patientId, clinicDateString(new Date(), CLINIC_TIME_ZONE), false, query as DbClient),
    canManage: scope.isProtectedOwner() || scope.granted("finance.legacy.record"),
  }), 1024 * 1024);
}

/** `GET /api/patients/[id]/debt-repayments`: the debt-repayment workspace (arrangements and
 * the debts that can be arranged). Read only; creating, revising and collecting prove
 * their own grants (group 4 slice 91). */
export async function readCanonicalDebtRepaymentWorkspace(session: VerifiedDurableSession, patientId: number) {
  return readCanonicalPatientRecord(session, "read:patients.ledger", patientId,
    async query => debtRepaymentWorkspaceInSnapshot(query as DbClient, patientId, clinicDateString(new Date(), CLINIC_TIME_ZONE)), 2 * 1024 * 1024);
}

/** `GET /api/finance/debts`: the debtors list, rows only inside the actor's patient scope
 * (`own`: the validated clinician's patients by the list predicate), the same 500-row cap. */
export async function readCanonicalPatientDebts(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(session, "read:finance.debts", async (query, scope) => {
    let ids: number[] | null = null;
    if (scope.patientScope.kind === "own") ids = await patientIdsInDoctorScopeWith(query, scope.patientScope.clinicianPartyId);
    else if (scope.patientScope.kind !== "all") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const rows = ids !== null && ids.length === 0 ? [] : (await computeDebtRowsInSnapshot(ids, false, query)).slice(0, 500);
    return { rows, baseCurrency: CLINIC_BASE_CURRENCY };
  }, { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 });
}

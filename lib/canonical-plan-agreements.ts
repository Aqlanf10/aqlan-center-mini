import "server-only";
import { getPool, patientInDoctorScopeWith, type DbClient } from "./db";
import {
  readAgreementAmendmentAttemptStatusOn, readAgreementAmendmentWith, saveAgreementAmendmentOn, type AmendmentWrite,
} from "./agreement-amendment-db";
import {
  AgreementReconciliationError, readAgreementReconciliationAttemptStatusOn, readAgreementReconciliationWith, saveAgreementReconciliationOn,
} from "./agreement-reconciliation-db";
import type { AgreementReconciliationCommand } from "./agreement-reconciliation";
import { CanonicalPlanRefusal, earlyInside, lockedAdmission, PLAN_MISSING } from "./canonical-plan-writes";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { canonicalDebtActor, DebtRepaymentError } from "./debt-installments-db";
import { staffOperationCapabilities, staffOperationIdentity, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * The agreement amendment and the agreement reconciliation on the canonical runtime (M2 slice
 * 94d-2; owner decisions G4-1, G4-8; contract section 13). `finance.agreements.manage` on all
 * six methods; the label decides nothing.
 *  - GET: one read-only snapshot under `read:plans.agreement`; the plan resolves to its patient
 *    there, and an outside plan reads exactly like a missing one (the writer's own refusal).
 *  - POST: the legacy writer on the admitted operation's transaction (`…On`), the branded actor
 *    re-proving the grant where the writer revalidated its session, the scope decided right
 *    after the patient row lock. A stale source commits its rejection proof, then is refused.
 *  - PUT: the status of one exact attempt; the patient row is held FOR SHARE to decide the
 *    scope before any saved attempt is read; nothing is written.
 */
const ACTION = "finance.agreements.manage" as const;
const READ_MAX_BYTES = 1024 * 1024;

/** A committed stale-rejection outcome: the operation has committed its proof; the route
 * answers the writer's own 409. */
export class CanonicalAgreementStale extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CanonicalAgreementStale"; }
}

type Writer = "amendment" | "reconciliation";
const missing = (writer: Writer): Error => writer === "amendment"
  ? new DebtRepaymentError("missing", "الخطة غير موجودة.")
  : new AgreementReconciliationError("missing", "الخطة غير موجودة.", 404);
const invalidPlan = (writer: Writer): Error => writer === "amendment"
  ? new DebtRepaymentError("invalid", "معرف الخطة غير صالح.")
  : new AgreementReconciliationError("invalid", "رقم الخطة غير صالح.", 400);

async function readPlanAgreement<T>(session: VerifiedDurableSession, writer: Writer, planId: number, reader: (client: DbClient) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(planId) || planId <= 0) throw invalidPlan(writer);
  return runCanonicalReadSnapshot(session, "read:plans.agreement", async (query, scope) => {
    const { rows: [plan] } = await query.query<{ patient_id: number }>("SELECT patient_id FROM treatment_plans WHERE id = $1", [planId]);
    const inside = !!plan && (scope.patientScope.kind === "all"
      || (scope.patientScope.kind === "own" && await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, plan.patient_id)));
    if (!inside) throw missing(writer);
    return reader(query as DbClient);
  }, { errorPrefix: "STAFF_READ", maxBytes: READ_MAX_BYTES });
}

/** GET /api/plans/[id]/agreement-amendment. */
export function readCanonicalAgreementAmendment(session: VerifiedDurableSession, planId: number) {
  return readPlanAgreement(session, "amendment", planId, client => readAgreementAmendmentWith(client, planId));
}
/** GET /api/plans/[id]/reconcile. */
export function readCanonicalAgreementReconciliation(session: VerifiedDurableSession, planId: number) {
  return readPlanAgreement(session, "reconciliation", planId, client => readAgreementReconciliationWith(client, planId));
}

/** The operation's actor: re-proves the live operation and the grant on the same client. */
async function operationActor(client: DbClient, handle: StaffOperationHandle) {
  const identity = await staffOperationIdentity(client, handle, ACTION);
  return canonicalDebtActor(identity, async current => current === client
    && (await staffOperationCapabilities(current, handle, ACTION, [ACTION] as const)).has(ACTION));
}

/** The early unlocked look: outside or missing reads as the writer's own missing refusal. */
async function earlyPlanPatient(client: DbClient, handle: StaffOperationHandle, writer: Writer, planId: number): Promise<number> {
  if (!Number.isSafeInteger(planId) || planId <= 0) throw invalidPlan(writer);
  const { rows: [plan] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM treatment_plans WHERE id = $1", [planId]);
  if (!plan || !await earlyInside(client, handle, ACTION, plan.patient_id)) throw missing(writer);
  return plan.patient_id;
}

/** After the writer's patient row lock: the authoritative scope decision; outside reads as missing. */
function admitAfterLock(client: DbClient, handle: StaffOperationHandle, writer: Writer, expectedPatientId: number) {
  const admit = lockedAdmission(client, handle, ACTION, PLAN_MISSING);
  return async (lockedPatientId: number) => {
    if (lockedPatientId !== expectedPatientId) throw new CanonicalPlanRefusal("plan_patient_changed", 409, "تغيّر مريض الخطة أثناء الطلب. حدّث الصفحة.");
    try { await admit(lockedPatientId); }
    catch (error) { if (error instanceof CanonicalPlanRefusal && error.code === "plan_not_found") throw missing(writer); throw error; }
  };
}

/** The status check's scope: hold the patient row FOR SHARE, then decide. */
function statusScope(client: DbClient, handle: StaffOperationHandle, writer: Writer, planId: number, patientId: number) {
  const admit = admitAfterLock(client, handle, writer, patientId);
  return async () => {
    const { rows: [plan] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM treatment_plans WHERE id = $1", [planId]);
    if (!plan) throw missing(writer);
    await client.query("SELECT id FROM patients WHERE id = $1 FOR SHARE", [plan.patient_id]);
    await admit(plan.patient_id);
  };
}

/** POST /api/plans/[id]/agreement-amendment. */
export async function commandCanonicalAgreementAmendment(session: VerifiedDurableSession, planId: number, input: AmendmentWrite, pool = getPool()) {
  const outcome = await withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const patientId = await earlyPlanPatient(client, handle, "amendment", planId);
    return saveAgreementAmendmentOn(client, planId, input, await operationActor(client, handle), admitAfterLock(client, handle, "amendment", patientId));
  });
  if ("stale" in outcome) throw new CanonicalAgreementStale("stale", outcome.message);
  return outcome;
}

/** PUT /api/plans/[id]/agreement-amendment: the status of one exact attempt. */
export async function readCanonicalAgreementAmendmentStatus(session: VerifiedDurableSession, planId: number, input: AmendmentWrite, pool = getPool()) {
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const patientId = await earlyPlanPatient(client, handle, "amendment", planId);
    return readAgreementAmendmentAttemptStatusOn(client, planId, input, await operationActor(client, handle), statusScope(client, handle, "amendment", planId, patientId));
  });
}

/** POST /api/plans/[id]/reconcile. */
export async function commandCanonicalAgreementReconciliation(session: VerifiedDurableSession, planId: number, command: AgreementReconciliationCommand, pool = getPool()) {
  const result = await withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const patientId = await earlyPlanPatient(client, handle, "reconciliation", planId);
    return saveAgreementReconciliationOn(client, planId, command, await operationActor(client, handle), admitAfterLock(client, handle, "reconciliation", patientId));
  });
  if (result === null) throw new CanonicalAgreementStale("agreement_source_changed", "تغيّر المصدر أو يحتاج مراجعة؛ افحص حالة نفس المحاولة قبل تحديث المعاينة.");
  return result;
}

/** PUT /api/plans/[id]/reconcile: the status of one exact attempt. */
export async function readCanonicalAgreementReconciliationStatus(session: VerifiedDurableSession, planId: number, command: AgreementReconciliationCommand, pool = getPool()) {
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    const patientId = await earlyPlanPatient(client, handle, "reconciliation", planId);
    return readAgreementReconciliationAttemptStatusOn(client, planId, command, await operationActor(client, handle), statusScope(client, handle, "reconciliation", planId, patientId));
  });
}

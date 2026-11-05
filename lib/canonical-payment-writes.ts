import "server-only";
import { correctPaymentOn, doctorOwnsPatient, getPool, patientInDoctorScopeWith, type CorrectPaymentInput, type CorrectPaymentRefusal, type DbClient } from "./db";
import { canonicalDebtActor, DebtRepaymentError, saveDebtRepaymentOn, type DebtRepaymentWrite } from "./debt-installments-db";
import { collectDebtInstallmentOn, type DebtCollectionInput } from "./debt-installment-collection";
import type { SimilarCollectionReview } from "./similar-collection";
import {
  staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation,
  type StaffOperationHandle,
} from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Payment correction and debt repayment on the canonical runtime (M2 slice 91; group 4
 * design: docs/review/financial-group4-contract-design-20261104.md).
 *
 * One admitted operation per write, the legacy writer body unchanged on the operation's
 * transaction (`…On`), its lock order kept after the staff authority locks; the audit row
 * in the same transaction; the legacy request keys and replay rules. Unchanged business
 * rules: an open cashier shift (the legacy writers refuse without one), the exchange-rate
 * and remaining-debt guards, the similar-collection review.
 *
 *  - `POST /api/payments/[id]/correct`: `finance.payments.void`; `mode: "correct"` (a
 *    replacement receipt) also needs `finance.payments.collect` (map branch). The legacy
 *    rule was the admin label alone. Any refusal outcome rolls the whole operation back.
 *  - `POST /api/patients/[id]/debt-repayments` (arrange, revise, cancel) and
 *    `POST …/debt-repayments/[arrangementId]/collect`: `finance.payments.collect` inside the
 *    patient scope (outside reads like missing). The writers re-check the live operation and
 *    the grant on the same transaction wherever legacy revalidated its session
 *    (`canonicalDebtActor`), and decide the patient scope after all their locks
 *    (`lockedDebtAdmission`).
 */
export class CanonicalPaymentRefusal extends Error {
  constructor(readonly code: string, readonly status: 403 | 404 | 409, message: string) { super(message); this.name = "CanonicalPaymentRefusal"; }
}
/** A legacy correction refusal outcome, raised so the operation rolls back. */
export class CanonicalCorrectionOutcome extends Error {
  constructor(readonly reason: CorrectPaymentRefusal) { super(reason); this.name = "CanonicalCorrectionOutcome"; }
}

export interface CanonicalCorrectionCommand {
  paymentId: number;
  reason: string;
  idempotencyKey: string | null;
  replacement: null | (Omit<NonNullable<CorrectPaymentInput["replacement"]>, "exchangeRate">);
}
/** Chooses the replacement's rate exactly as the legacy route (saved-key rate for the same
 * actor, else the configured rate) and the optional acknowledgment witness. */
export type CorrectionRateResolver = (actor: string) => Promise<{ exchangeRate: number | null; acknowledgmentRate: number | null }>;

export async function commandCanonicalPaymentCorrection(session: VerifiedDurableSession, command: CanonicalCorrectionCommand,
  resolveRate: CorrectionRateResolver, pool = getPool()) {
  return withStaffOperation(pool, session, "finance.payments.void", async (client, handle) => {
    const held = await staffOperationCapabilities(client, handle, "finance.payments.void", ["finance.payments.void", "finance.payments.collect"] as const);
    if (!held.has("finance.payments.void")) throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
    if (command.replacement && !held.has("finance.payments.collect")) {
      throw new CanonicalPaymentRefusal("collect_not_granted", 403, "إصدار السند الصحيح بدل الخطأ يحتاج صلاحية التحصيل؛ يمكنك إبطال السند فقط.");
    }
    const identity = await staffOperationIdentity(client, handle, "finance.payments.void");
    let replacement: CorrectPaymentInput["replacement"] = null;
    let acknowledgment: { observedExchangeRate: number | null } | undefined;
    if (command.replacement) {
      const rate = await resolveRate(identity.username);
      if (rate.exchangeRate === null) throw new CanonicalPaymentRefusal("exchange_rate_missing", 409, "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية.");
      replacement = { ...command.replacement, exchangeRate: rate.exchangeRate };
      acknowledgment = { observedExchangeRate: rate.acknowledgmentRate };
    }
    const outcome = await correctPaymentOn(client, {
      paymentId: command.paymentId, reason: command.reason, actor: identity.username, actorRole: identity.role,
      idempotencyKey: command.idempotencyKey, replacement,
    }, acknowledgment, false);
    if (outcome.reason !== null) throw new CanonicalCorrectionOutcome(outcome.reason);
    return outcome;
  });
}

async function admitDebtPatient(client: DbClient, handle: StaffOperationHandle, patientId: number) {
  const scope = await staffOperationPatientScope(client, handle, "finance.payments.collect");
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows } = await client.query<{ id: number }>("SELECT id FROM patients WHERE id = $1", [patientId]);
  if (!rows.length || (scope.kind === "own" && !await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId))) {
    throw new CanonicalPaymentRefusal("patient_not_found", 404, "المريض غير موجود.");
  }
}

/** The authoritative scope decision, called by the debt writers after all their locks: an
 * `own` actor needs a positive ownership witness held FOR SHARE to commit (NOWAIT: lock-order
 * contention is a bounded refusal), the mechanism of the reviewed fix 2fb7c07c. The early
 * check above only answers missing or outside quickly. */
function lockedDebtAdmission(client: DbClient, handle: StaffOperationHandle, patientId: number) {
  return async () => {
    const scope = await staffOperationPatientScope(client, handle, "finance.payments.collect");
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "all") return;
    let inside: boolean;
    try { inside = await doctorOwnsPatient(scope.clinicianPartyId, patientId, client, "nowait"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
        throw new CanonicalPaymentRefusal("patient_scope_conflict", 409, "تعذّر تثبيت نطاق المريض. حدّث الحساب وراجع النتيجة قبل طلب جديد.");
      }
      throw error;
    }
    if (!inside) throw new CanonicalPaymentRefusal("patient_not_found", 404, "المريض غير موجود.");
  };
}

/** The canonical actor for the debt writers: bound to this operation's handle and client. */
async function debtActor(client: DbClient, handle: StaffOperationHandle) {
  const identity = await staffOperationIdentity(client, handle, "finance.payments.collect");
  return canonicalDebtActor(identity, async current => current === client
    && (await staffOperationCapabilities(current, handle, "finance.payments.collect", ["finance.payments.collect"] as const)).has("finance.payments.collect"));
}

export async function commandCanonicalDebtRepayment(session: VerifiedDurableSession, input: Omit<DebtRepaymentWrite, "session">, pool = getPool()) {
  if (!Number.isSafeInteger(input.target.patientId) || input.target.patientId <= 0) throw new DebtRepaymentError("invalid", "رقم المريض غير صالح.");
  return withStaffOperation(pool, session, "finance.payments.collect", async (client, handle) => {
    await admitDebtPatient(client, handle, input.target.patientId);
    return saveDebtRepaymentOn(client, { ...input, session: await debtActor(client, handle) }, lockedDebtAdmission(client, handle, input.target.patientId));
  });
}

export async function commandCanonicalDebtCollection(session: VerifiedDurableSession, input: Omit<DebtCollectionInput, "session">,
  options: { similarityReview?: SimilarCollectionReview }, pool = getPool()) {
  if (!Number.isSafeInteger(input.patientId) || input.patientId <= 0) throw new DebtRepaymentError("invalid", "رقم المريض غير صالح.");
  return withStaffOperation(pool, session, "finance.payments.collect", async (client, handle) => {
    await admitDebtPatient(client, handle, input.patientId);
    return collectDebtInstallmentOn(client, { ...input, session: await debtActor(client, handle) },
      { ...options, afterLocks: lockedDebtAdmission(client, handle, input.patientId) }, false);
  });
}

import "server-only";
import {
  CLINIC_TIME_ZONE, doctorOwnsPatient, getPaymentWith, getPool, getSettingsWith, insertAuditRow, isPlanFundedByAgreementWith, listPatientPlansWith,
  patientInDoctorScopeWith, recordPaymentOn, recordPlanInstallmentOn, recordReversedInstallmentRecoveryOn, recordSettingsOwnedPaymentOn, type DbClient,
} from "./db";
import { collectApprovedAgreementOn, hydrateApprovedCollection } from "./approved-agreements";
import { canonicalDebtActor } from "./debt-installments-db";
import { CLINIC_BASE_CURRENCY, FinancialCurrencyIntegrityError, type Currency } from "./money";
import type { RecoveryIntent } from "./reversed-installment-recovery";
import { clinicDateString } from "./schedule";
import { rateFromSettings, type SettingsMap } from "./settings";
import type { SimilarCollectionReview } from "./similar-collection";
import { staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Ordinary receipts and refunds on the canonical runtime (M2 slice 90b; owner decision
 * G4-4: the collect action needs `finance.payments.collect`, inside the patient scope, with
 * the existing writer controls).
 *  - a receipt: `finance.payments.collect` (legacy admin/reception labels, a cashier with
 *    the collect switch); a refund of a receipt: `finance.payments.refund` (legacy admin
 *    label only). Neither implies the other, and neither implies a read.
 *  - one admitted operation; the legacy writer (`runPaymentTransaction`) on its transaction
 *    with its lock order (patient, origin, shift, targets), the request key and fingerprint,
 *    the settings-owned exchange rate, the similar-receipt review and the receipt audit in
 *    the same transaction; any refusal outcome rolls the whole operation back.
 *  - the patient scope decided after the writer's patient, origin and shift locks and before
 *    its targets, replay and refusals (`admit`): an `own` actor needs a positive ownership
 *    witness FOR SHARE NOWAIT, held to commit; an early unlocked look refuses the stable
 *    outside case first; outside or missing reads alike.
 *  - slice 90c: a receipt on an agreement-funded plan becomes, as in legacy, an instalment
 *    with its invoice (`recordPlanInstallmentOn`) or an approved-agreement collection
 *    (`collectApprovedAgreementOn`, with a branded canonical actor that re-proves the collect
 *    grant on the same client where the legacy writer revalidated its session); the
 *    reversed-instalment recovery is `commandCanonicalRecovery`. Each decides the scope after
 *    its own writer's locks, under `finance.payments.collect`.
 */
export class CanonicalReceiptRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "CanonicalReceiptRefusal"; }
}
/** A legacy writer refusal reason, raised so the operation rolls back; the route maps it by
 * the writer that refused (the ordinary receipt, the plan instalment or the recovery). */
export class CanonicalReceiptOutcome extends Error {
  constructor(readonly reason: string, readonly path: "ordinary" | "installment" | "recovery" = "ordinary",
    readonly detail: { recoveryInvoiceIds?: number[]; planCurrency?: Currency } = {}) { super(reason); this.name = "CanonicalReceiptOutcome"; }
}

export interface CanonicalReceiptCommand {
  kind: "payment" | "refund";
  patientId: number; invoiceId: number | null; planId: number | null; openingCurrency: Currency | null;
  amountMinor: number; currency: Currency; method: "cash" | "transfer"; note: string | null;
  idempotencyKey: string; reversalOfId: number | null; similarityReview: SimilarCollectionReview;
}

function scopeAdmission(client: DbClient, handle: StaffOperationHandle, action: "finance.payments.collect" | "finance.payments.refund", patientId: number) {
  return async () => {
    const scope = await staffOperationPatientScope(client, handle, action);
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "all") return;
    let inside: boolean;
    try { inside = await doctorOwnsPatient(scope.clinicianPartyId, patientId, client, "nowait"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
        throw new CanonicalReceiptRefusal("patient_scope_conflict", 409, "تعذّر تثبيت نطاق المريض. حدّث الحساب وراجع النتيجة قبل طلب جديد.");
      }
      throw error;
    }
    if (!inside) throw new CanonicalReceiptRefusal("patient_not_found", 404, "المريض غير موجود.");
  };
}

/** The early, unlocked look: an outside patient reads as missing before anything reveals it;
 * the authoritative decision is each writer's after-lock `admit`. */
async function earlyScope(client: DbClient, handle: StaffOperationHandle, action: "finance.payments.collect" | "finance.payments.refund", patientId: number) {
  const early = await staffOperationPatientScope(client, handle, action);
  if (early.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  if (early.kind === "own" && !await patientInDoctorScopeWith(client, early.clinicianPartyId, patientId)) {
    throw new CanonicalReceiptRefusal("patient_not_found", 404, "المريض غير موجود.");
  }
}

/** The rate as the legacy route takes it: the saved rate on this key for the same actor,
 * patient and currency, else the configured one. */
async function routeRate(client: DbClient, settings: SettingsMap, command: { idempotencyKey: string; patientId: number; currency: Currency }, username: string) {
  const { rows: [saved] } = await client.query<{ patient_id: number; created_by: string; currency: string; exchange_rate: string }>(
    "SELECT patient_id, created_by, currency, exchange_rate::text FROM payments WHERE idempotency_key = $1", [command.idempotencyKey]);
  return saved && saved.patient_id === command.patientId && saved.created_by === username && saved.currency === command.currency
    ? Number(saved.exchange_rate) : rateFromSettings(settings, command.currency, CLINIC_BASE_CURRENCY);
}

/** A receipt on an agreement-funded plan, as the legacy route serves it (BILL-1): the approved
 * agreement's collection, else the next instalment with its invoice. Null: the plan is not this
 * patient's (the ordinary writer then refuses it as legacy does). */
async function fundedPlanReceipt(client: DbClient, handle: StaffOperationHandle, identity: { userId: number; username: string; role: string },
  settings: SettingsMap, command: CanonicalReceiptCommand & { planId: number }, admit: () => Promise<void>) {
  const rate = await routeRate(client, settings, command, identity.username);
  if (rate === null) throw new CanonicalReceiptOutcome("exchange_rate_required", "installment");
  const plan = (await listPatientPlansWith(client, command.patientId, clinicDateString(new Date(), CLINIC_TIME_ZONE))).find(row => row.id === command.planId);
  if (!plan || plan.patientId !== command.patientId) return null;
  if (plan.approvedAgreement) {
    const actor = canonicalDebtActor(identity, async current => current === client
      && (await staffOperationCapabilities(current, handle, "finance.payments.collect", ["finance.payments.collect"] as const)).has("finance.payments.collect"));
    const receipt = await collectApprovedAgreementOn(client, { planId: command.planId, amountMinor: command.amountMinor, currency: command.currency,
      method: command.method, note: command.note, idempotencyKey: command.idempotencyKey, session: actor }, { similarityReview: command.similarityReview },
    async patientId => {
      if (patientId !== command.patientId) throw new CanonicalReceiptRefusal("plan_patient_changed", 409, "تغيّر مريض الاتفاق أثناء التحصيل. حدّث الحساب.");
      await admit();
    });
    const result = await hydrateApprovedCollection(receipt, id => getPaymentWith(client, id));
    const split = "collection" in result && result.collection && "payments" in result && Array.isArray(result.payments);
    return { payment: result.payment, replayed: result.replayed === true,
      ...(split ? { collection: { kind: "approved_agreement_split_v1", ...result.collection, receipts: result.payments },
        paymentIds: result.paymentIds, allocations: result.collection.allocations, collectionAmountMinor: result.collection.amountMinor } : {}) };
  }
  let result: Awaited<ReturnType<typeof recordPlanInstallmentOn>>;
  try {
    result = await recordPlanInstallmentOn(client, { planId: command.planId, patientId: command.patientId,
      installmentNumber: Math.min(plan.progress.paidCount + 1, plan.installments.length || 1), planTitle: plan.title,
      amountMinor: command.amountMinor, currency: command.currency, baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate: rate, method: command.method,
      note: command.note, createdBy: identity.username, actorRole: identity.role, idempotencyKey: command.idempotencyKey,
      similarityReview: command.similarityReview }, admit);
  } catch (error) {
    if (error instanceof FinancialCurrencyIntegrityError) throw new CanonicalReceiptOutcome("installment_recovery_review_required", "installment", { planCurrency: plan.baseCurrency });
    throw error;
  }
  if ("reason" in result) throw new CanonicalReceiptOutcome(result.reason, "installment", { planCurrency: plan.baseCurrency,
    ...(result.recoveryInvoiceIds ? { recoveryInvoiceIds: result.recoveryInvoiceIds } : {}) });
  return { payment: await getPaymentWith(client, result.paymentId), replayed: result.replayed === true };
}

export async function commandCanonicalReceipt(session: VerifiedDurableSession, command: CanonicalReceiptCommand, pool = getPool()) {
  const action = command.kind === "refund" ? "finance.payments.refund" as const : "finance.payments.collect" as const;
  return withStaffOperation(pool, session, action, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, action);
    await earlyScope(client, handle, action, command.patientId);
    const settings = await getSettingsWith(client);
    const admit = scopeAdmission(client, handle, action, command.patientId);
    if (command.kind === "payment" && command.planId !== null && await isPlanFundedByAgreementWith(client, command.planId, command.patientId)) {
      const funded = await fundedPlanReceipt(client, handle, identity, settings, { ...command, planId: command.planId }, admit);
      if (funded) return funded;
    }
    const base = { patientId: command.patientId, invoiceId: command.invoiceId, planId: command.planId, openingCurrency: command.openingCurrency,
      amountMinor: command.amountMinor, currency: command.currency, baseCurrency: CLINIC_BASE_CURRENCY, method: command.method, note: command.note,
      createdBy: identity.username, idempotencyKey: command.idempotencyKey, actorRole: identity.role };
    let result: { payment: unknown; reason: string | null; replayed?: boolean; acknowledgmentEvidence?: unknown };
    if (command.kind === "payment") {
      result = await recordSettingsOwnedPaymentOn(client, { ...base, similarityReview: command.similarityReview }, settings, admit);
    } else {
      const rate = await routeRate(client, settings, command, identity.username);
      if (rate === null) throw new CanonicalReceiptOutcome("exchange_rate_required");
      result = await recordPaymentOn(client, { ...base, kind: "refund", exchangeRate: rate, reversalOfId: command.reversalOfId }, admit);
    }
    if (result.reason !== null) throw new CanonicalReceiptOutcome(result.reason);
    const payment = result.payment as { id: number; receiptNumber: string };
    if (result.replayed) {
      await insertAuditRow(client, { action: "payment.idempotent_replay", entity: "payment", entityId: payment.id, entityLabel: payment.receiptNumber,
        details: { المريض: command.patientId, مفتاح_الإعادة: command.idempotencyKey }, actor: identity.username, actorRole: identity.role });
    }
    return { payment, replayed: result.replayed === true, ...(result.acknowledgmentEvidence ? { acknowledgmentEvidence: result.acknowledgmentEvidence } : {}) };
  });
}

/** The reversed-instalment recovery on the canonical runtime (M2 slice 90c): the legacy
 * recovery writer (its replay, origin, shift, opening, invoice and plan locks, the shared
 * receipt writer and its recovery audit) on the operation's transaction, under
 * `finance.payments.collect`, the scope decided after every lock; any refusal rolls back. */
export async function commandCanonicalRecovery(session: VerifiedDurableSession, intent: RecoveryIntent, idempotencyKey: string,
  similarityReview: SimilarCollectionReview, pool = getPool()) {
  return withStaffOperation(pool, session, "finance.payments.collect", async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "finance.payments.collect");
    await earlyScope(client, handle, "finance.payments.collect", intent.patientId);
    const result = await recordReversedInstallmentRecoveryOn(client, { ...intent, idempotencyKey, createdBy: identity.username, actorRole: identity.role },
      { similarityReview }, scopeAdmission(client, handle, "finance.payments.collect", intent.patientId));
    if (result.reason !== null || !result.payment) throw new CanonicalReceiptOutcome(result.reason ?? "recovery_review_required", "recovery");
    return { payment: result.payment, replayed: result.replayed === true };
  });
}

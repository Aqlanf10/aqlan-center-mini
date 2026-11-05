import "server-only";
import {
  doctorOwnsPatient, getPool, getSettingsWith, insertAuditRow, isPlanFundedByAgreementWith, patientInDoctorScopeWith,
  recordPaymentOn, recordSettingsOwnedPaymentOn, type DbClient,
} from "./db";
import { CLINIC_BASE_CURRENCY, type Currency } from "./money";
import { rateFromSettings } from "./settings";
import type { SimilarCollectionReview } from "./similar-collection";
import { staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
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
 *  - held for slice 90c: a receipt on an agreement-funded plan (it becomes an instalment
 *    with its invoice or an approved-agreement split) and the reversed-instalment recovery;
 *    refused explicitly (409), never served by the ordinary writer.
 */
export class CanonicalReceiptRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "CanonicalReceiptRefusal"; }
}
/** A legacy writer refusal reason, raised so the operation rolls back; the route maps it. */
export class CanonicalReceiptOutcome extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "CanonicalReceiptOutcome"; }
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

export async function commandCanonicalReceipt(session: VerifiedDurableSession, command: CanonicalReceiptCommand, pool = getPool()) {
  const action = command.kind === "refund" ? "finance.payments.refund" as const : "finance.payments.collect" as const;
  return withStaffOperation(pool, session, action, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, action);
    // An early, unlocked look so an outside patient reads as missing before the plan or the
    // receipt being refunded can reveal anything; the authoritative decision is `admit` below.
    const early = await staffOperationPatientScope(client, handle, action);
    if (early.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (early.kind === "own" && !await patientInDoctorScopeWith(client, early.clinicianPartyId, command.patientId)) {
      throw new CanonicalReceiptRefusal("patient_not_found", 404, "المريض غير موجود.");
    }
    const settings = await getSettingsWith(client);
    if (command.kind === "payment" && command.planId !== null && await isPlanFundedByAgreementWith(client, command.planId, command.patientId)) {
      throw new CanonicalReceiptRefusal("plan_collection_not_canonical", 409, "تحصيل خطة ممولة باتفاق ينتقل في شريحة لاحقة؛ استعمله من الشاشة القديمة الآن.");
    }
    const admit = scopeAdmission(client, handle, action, command.patientId);
    const base = { patientId: command.patientId, invoiceId: command.invoiceId, planId: command.planId, openingCurrency: command.openingCurrency,
      amountMinor: command.amountMinor, currency: command.currency, baseCurrency: CLINIC_BASE_CURRENCY, method: command.method, note: command.note,
      createdBy: identity.username, idempotencyKey: command.idempotencyKey, actorRole: identity.role };
    let result: { payment: unknown; reason: string | null; replayed?: boolean; acknowledgmentEvidence?: unknown };
    if (command.kind === "payment") {
      result = await recordSettingsOwnedPaymentOn(client, { ...base, similarityReview: command.similarityReview }, settings, admit);
    } else {
      // The refund's rate as the legacy route: the saved rate on this key for the same actor and patient, else the configured one.
      const { rows: [saved] } = await client.query<{ patient_id: number; created_by: string; currency: string; exchange_rate: string }>(
        "SELECT patient_id, created_by, currency, exchange_rate::text FROM payments WHERE idempotency_key = $1", [command.idempotencyKey]);
      const rate = saved && saved.patient_id === command.patientId && saved.created_by === identity.username && saved.currency === command.currency
        ? Number(saved.exchange_rate) : rateFromSettings(settings, command.currency, CLINIC_BASE_CURRENCY);
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

import "server-only";
import {
  CLINIC_TIME_ZONE, doctorOwnsPatient, getPaymentWith, getPool, getSettingsWith, listPatientPlansWith, patientInDoctorScopeWith,
  recordPlanInstallmentOn, setPlanStatusOn, type DbClient,
} from "./db";
import { approveAgreementOn, collectApprovedAgreementOn, hydrateApprovedCollection, type AgreementSource } from "./approved-agreements";
import { canonicalDebtActor } from "./debt-installments-db";
import { CLINIC_BASE_CURRENCY, FinancialCurrencyIntegrityError, type Currency } from "./money";
import { clinicDateString } from "./schedule";
import type { PlanStatus } from "./plans";
import { rateFromSettings } from "./settings";
import type { SimilarCollectionReview } from "./similar-collection";
import { staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Plan status, the creation entry and the collection on a plan, on the canonical runtime
 * (M2 slice 94b; owner decisions G4-4, G4-8; contract section 10).
 *  - PATCH status: `clinical.plans.edit`; the legacy writer `setPlanStatusOn` (its plan row
 *    lock, reason rule and audit) with the scope decided right after the plan row lock.
 *  - POST /api/plans: `clinical.plans.edit` inside the scope, then the legacy refusal (new
 *    treatment starts from the invoice or the pre-system agreement); nothing is written.
 *  - POST /api/plans/[id]: `finance.payments.collect` (G4-4); the approved agreement's
 *    collection (a branded canonical actor where the legacy writer revalidated its session),
 *    else the next instalment with its invoice, each writer deciding the scope after its locks.
 * An outside plan or patient reads like a missing one; role labels decide nothing.
 */
export class CanonicalPlanRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "CanonicalPlanRefusal"; }
}
/** A legacy instalment writer refusal, raised so the operation rolls back; the route answers
 * it exactly as the legacy route does. */
export class CanonicalPlanInstallmentOutcome extends Error {
  constructor(readonly reason: string, readonly planCurrency: string, readonly recoveryInvoiceIds?: number[]) { super(reason); this.name = "CanonicalPlanInstallmentOutcome"; }
}

export const PLAN_MISSING = "الخطة غير موجودة.";
const PATIENT_MISSING = "المريض غير موجود.";
export type ScopedAction = "clinical.plans.edit" | "finance.payments.collect" | "finance.invoices.create" | "finance.agreements.manage" | "finance.legacy.record" | "finance.legacy.void";

export async function earlyInside(client: DbClient, handle: StaffOperationHandle, action: ScopedAction, patientId: number): Promise<boolean> {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  return scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
}

/** The authoritative decision after a writer's lock: an `own` actor needs a positive ownership
 * witness FOR SHARE NOWAIT, held until commit; a lock conflict is 409, outside reads as missing. */
export function lockedAdmission(client: DbClient, handle: StaffOperationHandle, action: ScopedAction, missing: string) {
  return async (patientId: number) => {
    const scope = await staffOperationPatientScope(client, handle, action);
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "all") return;
    let inside: boolean;
    try { inside = await doctorOwnsPatient(scope.clinicianPartyId, patientId, client, "nowait"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
        throw new CanonicalPlanRefusal("patient_scope_conflict", 409, "تعذّر تثبيت نطاق المريض. حدّث الصفحة وأعد المحاولة.");
      }
      throw error;
    }
    if (!inside) throw new CanonicalPlanRefusal("plan_not_found", 404, missing);
  };
}

export async function planPatient(client: DbClient, handle: StaffOperationHandle, action: ScopedAction, planId: number): Promise<number> {
  const { rows: [plan] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM treatment_plans WHERE id = $1", [planId]);
  if (!plan || !await earlyInside(client, handle, action, plan.patient_id)) throw new CanonicalPlanRefusal("plan_not_found", 404, PLAN_MISSING);
  return plan.patient_id;
}

/** PATCH /api/plans/[id]: the status change. */
export async function commandCanonicalPlanStatus(session: VerifiedDurableSession, planId: number, status: PlanStatus, reason: string | null, pool = getPool()) {
  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "clinical.plans.edit");
    await planPatient(client, handle, "clinical.plans.edit", planId);
    const done = await setPlanStatusOn(client, planId, status, { actor: identity.username, actorRole: identity.role, reason },
      lockedAdmission(client, handle, "clinical.plans.edit", PLAN_MISSING));
    if (done === "not_found") throw new CanonicalPlanRefusal("plan_not_found", 404, PLAN_MISSING);
    if (done === "reason_required") {
      throw new CanonicalPlanRefusal("reason_required", 400, status === "cancelled" ? "اكتب سبب إلغاء الخطة." : "اكتب سبب إعادة تفعيل الخطة الملغاة.");
    }
    return { ok: true as const };
  });
}

/** POST /api/plans: the creation entry. Admitted and scoped like a plan write, then refused as
 * legacy refuses every client; the operation writes nothing and rolls back. */
export async function commandCanonicalPlanCreateEntry(session: VerifiedDurableSession, patientId: number, pool = getPool()): Promise<never> {
  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const { rows: [patient] } = await client.query<{ id: number }>("SELECT id FROM patients WHERE id = $1", [patientId]);
    if (!patient || !await earlyInside(client, handle, "clinical.plans.edit", patientId)) throw new CanonicalPlanRefusal("patient_not_found", 404, PATIENT_MISSING);
    throw new CanonicalPlanRefusal("PLAN_CREATION_ENTRY_REQUIRED", 409, "ابدأ العلاج من الفاتورة أو الاتفاق السابق للنظام في حساب المريض.");
  });
}

export interface CanonicalPlanCollection {
  amountMinor: number; currency: Currency; method: "cash" | "transfer"; note: string | null;
  idempotencyKey: string; similarityReview: SimilarCollectionReview;
}

/** POST /api/plans/[id]: a collection on the plan, as the legacy route serves it. */
export async function commandCanonicalPlanCollection(session: VerifiedDurableSession, planId: number, command: CanonicalPlanCollection, pool = getPool()) {
  return withStaffOperation(pool, session, "finance.payments.collect", async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "finance.payments.collect");
    const patientId = await planPatient(client, handle, "finance.payments.collect", planId);
    const plan = (await listPatientPlansWith(client, patientId, clinicDateString(new Date(), CLINIC_TIME_ZONE))).find(row => row.id === planId);
    if (!plan) throw new CanonicalPlanRefusal("plan_not_found", 404, PLAN_MISSING);
    const admit = lockedAdmission(client, handle, "finance.payments.collect", PLAN_MISSING);
    if (plan.approvedAgreement) {
      const actor = canonicalDebtActor(identity, async current => current === client
        && (await staffOperationCapabilities(current, handle, "finance.payments.collect", ["finance.payments.collect"] as const)).has("finance.payments.collect"));
      const receipt = await collectApprovedAgreementOn(client, { planId, amountMinor: command.amountMinor, currency: command.currency,
        method: command.method, note: command.note, idempotencyKey: command.idempotencyKey, session: actor }, { similarityReview: command.similarityReview },
      async lockedPatientId => {
        if (lockedPatientId !== patientId) throw new CanonicalPlanRefusal("plan_patient_changed", 409, "تغيّر مريض الاتفاق أثناء التحصيل. حدّث الحساب.");
        await admit(lockedPatientId);
      });
      const result = await hydrateApprovedCollection(receipt, id => getPaymentWith(client, id));
      return { kind: "approved" as const, body: { ...result, invoiceId: plan.approvedAgreement.invoiceId } };
    }
    const exchangeRate = rateFromSettings(await getSettingsWith(client), command.currency, CLINIC_BASE_CURRENCY);
    if (exchangeRate === null) throw new CanonicalPlanRefusal("exchange_rate_required", 409, "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية.");
    let result: Awaited<ReturnType<typeof recordPlanInstallmentOn>>;
    try {
      result = await recordPlanInstallmentOn(client, { planId, patientId, installmentNumber: Math.min(plan.progress.paidCount + 1, plan.installments.length || 1),
        planTitle: plan.title, amountMinor: command.amountMinor, currency: command.currency, baseCurrency: CLINIC_BASE_CURRENCY, exchangeRate,
        method: command.method, note: command.note, createdBy: identity.username, actorRole: identity.role, idempotencyKey: command.idempotencyKey,
        similarityReview: command.similarityReview }, () => admit(patientId));
    } catch (error) {
      if (error instanceof FinancialCurrencyIntegrityError) throw new CanonicalPlanInstallmentOutcome("installment_recovery_review_required", plan.baseCurrency);
      throw error;
    }
    if ("reason" in result) throw new CanonicalPlanInstallmentOutcome(result.reason, plan.baseCurrency, result.recoveryInvoiceIds);
    return { kind: "installment" as const, body: result };
  });
}

/** POST /api/plans/[id]/financial-approval (M2 slice 94d-1; contract section 12): the legacy
 * approval writer under `finance.invoices.create`; matching an existing source (invoice or
 * opening) also needs `finance.agreements.manage` (legacy administrator only). The branded actor
 * re-proves exactly these grants wherever the writer revalidated its session; the scope is
 * decided right after the patient row lock. */
export async function commandCanonicalFinancialApproval(session: VerifiedDurableSession, planId: number,
  input: { expectedTotalMinor: number; currency: Currency; source: AgreementSource; reason: string; idempotencyKey: string }, pool = getPool()) {
  return withStaffOperation(pool, session, "finance.invoices.create", async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "finance.invoices.create");
    await planPatient(client, handle, "finance.invoices.create", planId);
    const needed = input.source.kind === "new" ? ["finance.invoices.create"] as const : ["finance.invoices.create", "finance.agreements.manage"] as const;
    const holds = async (current: DbClient) => {
      if (current !== client) return false;
      const held = await staffOperationCapabilities(current, handle, "finance.invoices.create", ["finance.invoices.create", "finance.agreements.manage"] as const);
      return needed.every(capability => held.has(capability));
    };
    if (!await holds(client)) throw new CanonicalPlanRefusal("agreement_source_not_granted", 403, "مطابقة أصل قائم تحتاج صلاحية إدارة الاتفاقات.");
    const result = await approveAgreementOn(client, { planId, ...input, session: canonicalDebtActor(identity, holds) },
      lockedAdmission(client, handle, "finance.invoices.create", PLAN_MISSING));
    return { planId: result.agreement.plan_id, replayed: result.replayed };
  });
}

import "server-only";
import { NextResponse } from "next/server";
import { collectCanonicalApprovedAgreementInTransaction, hydrateCollectedAgreementPayments } from "./canonical-approved-agreements";
import { canonicalPatientReadFailure, NO_STORE } from "./canonical-patient-http";
import { runCanonicalReadSnapshot, type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import { checkCaseDraft, checkCaseStatusChange, checkDependencyDraft } from "./cases";
import { isRetiredCollectionKey, retiredCollectionRefusal } from "./collection-attempts";
import { followUpDaysFrom, proposalTiming, sortProposals } from "./consultation-followup";
import {
  addPlanItemDependencyInTransaction,
  addPlanItemWith,
  changeClinicalCaseStatusWith,
  CLINIC_TIME_ZONE,
  createClinicalCaseWith,
  getClinicalCaseWith,
  getPlanCurrencyWith,
  getPlanItemPatientWith,
  getPlanWith,
  getPool,
  getServiceWith,
  getSettingsInTransaction,
  getSettingsWith,
  insertAuditRow,
  listActivePlansWith,
  listCasePlanItemsWith,
  listPatientCasesWith,
  listPatientPlannedVisitsWith,
  listPatientPlansWith,
  listPatientProblemsWith,
  listPendingProposalsWith,
  listServicesWith,
  patientInDoctorScopeWith,
  recordPlanConsentWith,
  recordPlanInstallmentInTransaction,
  recordPlanInstallmentRemindersWith,
  recordProposalContactWith,
  removePlanItemDependencyWith,
  removePlanItemWith,
  schedulePlanInstallmentsWith,
  setPlanItemCaseWith,
  setPlanStatusWith,
  updatePlanItemWith,
  type DbClient,
  type DbPool,
} from "./db";
import { DebtRepaymentError } from "./debt-installments-db";
import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";
import { invoiceCatalogPrice } from "./invoice-catalog-price";
import { agreementPricedService, formatPriceOverrides, type InvoicePriceOverride } from "./invoice-pricing";
import { CLINIC_BASE_CURRENCY, FinancialCurrencyIntegrityError, isCurrency, parseAmount, type Currency } from "./money";
import { withoutPlanPayments } from "./plan-payment-projection";
import type { BillingRule } from "./plans";
import { decideCanonicalProcedurePrice } from "./price-authority";
import { clinicDateString } from "./schedule";
import { rateFromSettings } from "./settings";
import {
  parseSimilarCollectionReviewHeader,
  similarCollectionRefusal,
  SimilarCollectionReviewRequired,
} from "./similar-collection";
import { effectiveTemplates } from "./specialty-templates";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationClinician,
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
  type StaffOperationHandle,
  type StaffRuntimeAction,
} from "./staff-operation-runtime";

/**
 * Canonical Treatment Plans & Clinical Cases (M2 slice 32).
 *
 * Covers the 15 treatment-plan and specialty-case routes (26 HTTP methods):
 *  - `GET /api/plan-templates`: `clinical.plans.view` (`scope: null`), projecting
 *    `showPrices` by `finance.service-prices.view` and `canEdit` by `settings.operational.edit`.
 *  - `GET /api/patients/[id]/plans`: `read:patients.plans` (`clinical.plans.view` + patient scope),
 *    projecting financial fields by `finance.patient-ledger.view` and `canRebook` by `appointments.create`.
 *  - `GET /api/plans`: `read:plans` (`anyOf: [clinical.plans.view, finance.invoices.view]` + patient scope),
 *    giving finance-only readers the clinical-redacted receivable summary and clinical readers
 *    plan items with financial fields gated by `finance.invoices.view` / `finance.patient-ledger.view`.
 *  - `POST /api/plans`: `clinical.plans.edit` + patient scope, preserving `PLAN_CREATION_ENTRY_REQUIRED`.
 *  - `POST /api/plans/[id]`: `finance.payments.collect` + patient scope + open shift.
 *  - `PATCH /api/plans/[id]`: `clinical.plans.edit` + patient scope (`setPlanStatusWith`).
 *  - `POST / PATCH / DELETE /api/plans/[id]/items`: `clinical.plans.edit` + patient scope, with
 *    capability-based foreign-currency price authority (`finance.price-increases.apply`,
 *    `finance.discounts.apply`, `finance.discounts.override`) and atomic `insertAuditRow`.
 *  - `POST /api/plans/[id]/consent`: `clinical.plans.edit` + patient scope.
 *  - `GET / POST /api/plans/proposals`: `read:plans.proposals` / `clinical.plans.edit` + patient scope.
 *  - `POST /api/plans/reminders`: `appointments.create` + patient scope.
 *  - `GET / POST /api/patients/[id]/cases`, `PATCH /api/cases/[id]`: `read:patients.record` / `clinical.plans.edit` + patient scope.
 *  - `PUT /api/plan-items/[id]/case`, `POST / DELETE /api/plan-items/[id]/dependencies`: `clinical.plans.edit` + patient scope.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type CanonicalPlanCaseRefusalCode =
  | "invalid_plan_input"
  | "plan_not_found"
  | "patient_not_found"
  | "case_not_found"
  | "item_not_found"
  | "service_not_found"
  | "plan_forbidden"
  | "plan_conflict"
  | "PLAN_CREATION_ENTRY_REQUIRED";

export class CanonicalPlanCaseRefusal extends Error {
  constructor(
    readonly code: CanonicalPlanCaseRefusalCode,
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly extra?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CanonicalPlanCaseRefusal";
  }
}

class CanonicalPlanInstallmentRefusal extends Error {
  constructor(
    readonly outcome: Extract<Awaited<ReturnType<typeof recordPlanInstallmentInTransaction>>, { reason: string }>,
    readonly baseCurrency: Currency,
  ) {
    super(outcome.reason);
    this.name = "CanonicalPlanInstallmentRefusal";
  }
}

export function canonicalPlanCaseFailure(error: unknown, fallback: string): NextResponse {
  if (error instanceof CanonicalPlanCaseRefusal) {
    return NextResponse.json(
      { code: error.code, message: error.message, ...(error.extra ?? {}) },
      { status: error.status, headers: NO_STORE },
    );
  }
  if (error instanceof SimilarCollectionReviewRequired) {
    return NextResponse.json(similarCollectionRefusal(error), { status: 409, headers: NO_STORE });
  }
  if (isRetiredCollectionKey(error)) {
    return NextResponse.json(retiredCollectionRefusal(), { status: 409, headers: NO_STORE });
  }
  if (error instanceof DebtRepaymentError) {
    const status = error.code === "unauthorized" ? 403 : error.code === "missing" ? 404 : error.code === "invalid" ? 400 : 409;
    return NextResponse.json({ message: error.message, code: error.code }, { status, headers: NO_STORE });
  }
  if (error instanceof FinancialCurrencyIntegrityError) {
    return NextResponse.json(
      {
        reason: "installment_recovery_review_required",
        message: "يوجد قسط مُصدر يحتاج مراجعة ربطه قبل التحصيل. راجع المدير؛ لا تُصدر فاتورة بديلة.",
      },
      { status: 409, headers: NO_STORE },
    );
  }
  if (error instanceof CanonicalPlanInstallmentRefusal) {
    const { outcome, baseCurrency } = error;
    if (outcome.reason === "issued_installment_recovery_required" || outcome.reason === "installment_recovery_review_required") {
      return NextResponse.json(
        {
          reason: outcome.reason,
          message: outcome.reason === "issued_installment_recovery_required"
            ? "يوجد قسط مُصدر عُكس قبضه. اختر إعادة تحصيل الفاتورة الأصلية من الحساب؛ لا تُصدر قسطًا جديدًا."
            : "يوجد قسط مُصدر يحتاج مراجعة ربطه قبل التحصيل. راجع المدير؛ لا تُصدر فاتورة بديلة.",
          ...("recoveryInvoiceIds" in outcome ? { recoveryInvoiceIds: outcome.recoveryInvoiceIds } : {}),
        },
        { status: 409, headers: NO_STORE },
      );
    }
    if (outcome.reason === "plan_financial_history_requires_review") {
      return NextResponse.json(
        {
          reason: outcome.reason,
          message: "الخطة تحتوي علاجًا ذا سجل مالي أو اتفاق تاريخي؛ لا تُصدر قسطًا جديدًا له. اختر الفاتورة القائمة أو الرصيد السابق وراجع الربط المالي.",
        },
        { status: 409, headers: NO_STORE },
      );
    }
    if (outcome.reason === "inactive_plan") {
      return NextResponse.json({ message: "الخطة غير جارية — لا يمكن تسجيل تحصيل جديد عليها." }, { status: 409, headers: NO_STORE });
    }
    if (outcome.reason === "idempotency_conflict") {
      return NextResponse.json({ message: "مفتاح الإعادة مستعمل بعملية مختلفة — مفتاح واحد لعملية واحدة." }, { status: 409, headers: NO_STORE });
    }
    if (outcome.reason === "cross_currency_not_supported") {
      return NextResponse.json(
        { message: `القسط بعملةٍ مختلفة عن عملة الخطة (${baseCurrency}) غير مدعوم — حصّل بعملة الاتفاق نفسها.` },
        { status: 409, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { message: "لا توجد وردية مفتوحة. افتح الوردية من شاشة الصندوق أولًا." },
      { status: 409, headers: NO_STORE },
    );
  }
  return canonicalPatientReadFailure(error, fallback);
}

function positiveId(value: unknown): number | null {
  const n = Number(value);
  return typeof value !== "boolean" && value !== null && value !== "" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normalizeCount(value: unknown, min: number, max: number): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return undefined;
  return Math.min(max, Math.max(min, num));
}

function billingRuleFrom(value: unknown): BillingRule {
  return value === "per_session" || value === "on_start" || value === "package" ? value : "on_completion";
}

function doctorIdFrom(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

async function lockPatientAndAssertScope(
  client: DbClient,
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
  patientId: number,
  notFoundCode: CanonicalPlanCaseRefusalCode,
  notFoundMessage: string,
  lockMode: "FOR NO KEY UPDATE" | "FOR KEY SHARE" = "FOR NO KEY UPDATE",
) {
  const identity = await staffOperationIdentity(client, handle, action);
  const patientScope = await staffOperationPatientScope(client, handle, action);
  if (patientScope.kind === "none") {
    throw new CanonicalPlanCaseRefusal("plan_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
  }
  const { rows: [locked] } = await client.query<{ id: number }>(
    `SELECT id FROM patients WHERE id = $1 ${lockMode}`,
    [patientId],
  );
  if (!locked) {
    throw new CanonicalPlanCaseRefusal(notFoundCode, 404, notFoundMessage);
  }
  if (
    patientScope.kind === "own"
    && !(await patientInDoctorScopeWith(client, patientScope.clinicianPartyId, locked.id))
  ) {
    throw new CanonicalPlanCaseRefusal(notFoundCode, 404, notFoundMessage);
  }
  return { identity, patientScope };
}

async function assertPlanOwnerAndScope(
  client: DbClient,
  handle: StaffOperationHandle,
  action: StaffRuntimeAction,
  planId: number,
  lockMode: "FOR NO KEY UPDATE" | "FOR KEY SHARE" = "FOR NO KEY UPDATE",
) {
  const patientScope = await staffOperationPatientScope(client, handle, action);
  if (patientScope.kind === "none") {
    throw new CanonicalPlanCaseRefusal("plan_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
  }
  const { rows: [owner] } = await client.query<{ patient_id: number }>(
    `SELECT patient_id FROM treatment_plans WHERE id = $1`,
    [planId],
  );
  if (!owner) {
    throw new CanonicalPlanCaseRefusal("plan_not_found", 404, "الخطة غير موجودة.");
  }
  return {
    patientId: owner.patient_id,
    ...(await lockPatientAndAssertScope(client, handle, action, owner.patient_id, "plan_not_found", "الخطة غير موجودة.", lockMode)),
  };
}

function projectPlannedVisitForScope<T extends {
  canRebook: boolean;
  rebookBlockedReason: string | null;
  rebookHasReferral?: boolean;
  rebookReferralReceiverId?: number | null;
}>(visit: T, scope: Pick<CanonicalSnapshotScope, "granted" | "appointmentScope">) {
  const { rebookHasReferral: referral, rebookReferralReceiverId: receiver, ...visible } = visit;
  const clinician = scope.appointmentScope.kind === "own" ? scope.appointmentScope.clinicianPartyId : null;
  const granted = scope.granted("appointments.create") && scope.appointmentScope.kind !== "none";
  const referralAllowed = !referral || clinician === null || receiver === clinician;
  if (!visible.canRebook) return visible;
  if (!granted) return { ...visible, canRebook: false, rebookBlockedReason: "إعادة الحجز تحتاج صلاحية حجز المواعيد." };
  if (!referralAllowed) return { ...visible, canRebook: false, rebookBlockedReason: "إعادة حجز الإحالة للطبيب المحال إليه." };
  return visible;
}

export async function readCanonicalPlanTemplates(
  session: VerifiedDurableSession,
  pool: DbPool = getPool(),
) {
  return withStaffOperation(pool, session, "clinical.plans.view", async (client, handle) => {
    const granted = await staffOperationCapabilities(
      client,
      handle,
      "clinical.plans.view",
      ["finance.service-prices.view", "settings.operational.edit"] as const,
    );
    const showPrices = granted.has("finance.service-prices.view");
    const canEdit = granted.has("settings.operational.edit");
    const [settings, catalog] = await Promise.all([getSettingsWith(client), listServicesWith(client)]);
    const { templates, customized } = effectiveTemplates(settings["plans.specialty_templates"]);
    const services = catalog.map((service) => ({
      id: service.id,
      name: service.name,
      category: service.category,
      sortOrder: service.sortOrder,
      isActive: service.isActive,
      priceMinor: showPrices ? service.priceMinor : null,
    }));
    return { templates, customized, canEdit, services, showPrices };
  });
}

export async function readCanonicalPatientPlans(
  session: VerifiedDurableSession,
  rawPatientId: unknown,
) {
  const patientId = positiveId(rawPatientId);
  if (!patientId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم ملف غير صالح.");

  return runCanonicalReadSnapshot(
    session,
    "read:patients.plans",
    async (query, scope) => {
      const { rows: [exists] } = await query.query<{ id: number }>(`SELECT id FROM patients WHERE id = $1`, [patientId]);
      if (!exists) throw new CanonicalPlanCaseRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
      if (
        scope.patientScope.kind === "own"
        && !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId))
      ) {
        throw new CanonicalPlanCaseRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
      }

      const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
      const maySeeFinancial = scope.granted("finance.patient-ledger.view");
      const plans = await listPatientPlansWith(query, patientId, today);
      const plannedVisits = await listPatientPlannedVisitsWith(query, patientId);
      const visiblePlans = maySeeFinancial ? plans : plans.map((plan) => withoutPlanPayments(plan));

      return {
        plans: visiblePlans,
        plannedVisits: plannedVisits.map((visit) => projectPlannedVisitForScope(visit, scope)),
        today,
        baseCurrency: CLINIC_BASE_CURRENCY,
        canSeeFinancial: maySeeFinancial,
      };
    },
    { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 },
  );
}

export async function readCanonicalPlans(
  session: VerifiedDurableSession,
  rawPatientId: string | null,
) {
  let patientId: number | null = null;
  if (rawPatientId !== null && rawPatientId.trim() !== "") {
    patientId = positiveId(rawPatientId);
    if (!patientId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم مريض غير صالح.");
  }

  return runCanonicalReadSnapshot(
    session,
    "read:plans",
    async (query, scope) => {
      const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
      let plans;
      if (patientId !== null) {
        const { rows: [exists] } = await query.query<{ id: number }>(`SELECT id FROM patients WHERE id = $1`, [patientId]);
        if (!exists) throw new CanonicalPlanCaseRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
        if (
          scope.patientScope.kind === "own"
          && !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId))
        ) {
          throw new CanonicalPlanCaseRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
        }
        plans = await listPatientPlansWith(query, patientId, today);
      } else {
        const clinicianPartyId = scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null;
        plans = await listActivePlansWith(query, today, clinicianPartyId);
      }

      const hasClinicalPlans = scope.granted("clinical.plans.view");
      const canSeeFinancial = scope.granted("finance.invoices.view") || scope.granted("finance.patient-ledger.view");

      const result = !hasClinicalPlans
        ? plans.map((plan) => ({
            id: plan.id,
            patientId: plan.patientId,
            patientName: plan.patientName,
            patientPhone: plan.patientPhone,
            title: `خطة مالية #${plan.id}`,
            totalMinor: plan.totalMinor,
            baseCurrency: plan.baseCurrency,
            status: plan.status,
            lastReminderAt: plan.lastReminderAt,
            installments: plan.installments,
            paidMinor: plan.paidMinor,
            progress: plan.progress,
            invoiceFinancial: plan.invoiceFinancial,
            approvedAgreement: plan.approvedAgreement,
            debtSource: plan.debtSource,
            agreementApproved: plan.agreementApproved === true,
          }))
        : canSeeFinancial
          ? plans
          : plans.map((plan) => withoutPlanPayments(plan, true));

      return { plans: result, today, baseCurrency: CLINIC_BASE_CURRENCY, canSeeFinancial };
    },
    { errorPrefix: "STAFF_READ", maxBytes: 4 * 1024 * 1024 },
  );
}

export async function commandCanonicalCreatePlanRefusal(
  session: VerifiedDurableSession,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<never> {
  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const patientScope = await staffOperationPatientScope(client, handle, "clinical.plans.edit");
    if (patientScope.kind === "none") {
      throw new CanonicalPlanCaseRefusal("plan_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
    }
    const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
    const patientId = positiveId(source.patientId);
    if (!patientId) {
      throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "اختر المريض أولًا.");
    }
    await lockPatientAndAssertScope(
      client,
      handle,
      "clinical.plans.edit",
      patientId,
      "patient_not_found",
      "لا يوجد مريض بهذا الرقم.",
      "FOR KEY SHARE",
    );
    throw new CanonicalPlanCaseRefusal(
      "PLAN_CREATION_ENTRY_REQUIRED",
      409,
      "ابدأ العلاج من الفاتورة أو الاتفاق السابق للنظام في حساب المريض.",
    );
  });
}

export async function commandCanonicalPlanCollect(
  session: VerifiedDurableSession,
  rawPlanId: unknown,
  rawBody: unknown,
  idempotencyKeyHeader: string | null,
  similarityReviewHeader: string | null,
  pool: DbPool = getPool(),
): Promise<{ body: Record<string, unknown>; status: 200 | 201 }> {
  const planId = positiveId(rawPlanId);
  if (!planId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم الخطة غير صالح.");

  const idempotencyKey = idempotencyKeyHeader && idempotencyKeyHeader.trim() ? idempotencyKeyHeader.trim() : null;
  if (!idempotencyKey) {
    throw new CanonicalPlanCaseRefusal(
      "invalid_plan_input",
      400,
      "مفتاح الإعادة (Idempotency-Key) مطلوب للتحصيل. أعد إرسال الطلب المحفوظ بالمفتاح نفسه.",
      { reason: "idempotency_key_required" },
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new CanonicalPlanCaseRefusal(
      "invalid_plan_input",
      400,
      "مفتاح الإعادة (Idempotency-Key) غير صالح: ٨–١٢٨ محرفًا من حروف وأرقام و . _ : -",
    );
  }

  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const currency = source.currency;
  if (!isCurrency(currency)) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "اختر العملة.");
  }
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor === 0) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "اكتب مبلغًا أكبر من صفر.");
  }
  const method = source.method === "transfer" ? "transfer" : "cash";
  const note = typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
  const similarityReview = parseSimilarCollectionReviewHeader(similarityReviewHeader);
  if (!similarityReview) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "مراجعة السندات المشابهة المرسلة غير صالحة. أعد فتح نافذة التحصيل.");
  }

  const outcome = await withStaffOperation(pool, session, "finance.payments.collect", async (client, handle) => {
    const { identity } = await assertPlanOwnerAndScope(client, handle, "finance.payments.collect", planId, "FOR KEY SHARE");
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const plan = await getPlanWith(client, planId, today);
    if (!plan) throw new CanonicalPlanCaseRefusal("plan_not_found", 404, "الخطة غير موجودة.");

    if (plan.approvedAgreement) {
      const receipt = await collectCanonicalApprovedAgreementInTransaction(
        client,
        handle,
        "finance.payments.collect",
        { planId, amountMinor, currency, method, note, idempotencyKey },
        { similarityReview },
      );
      return {
        kind: "approved" as const,
        invoiceId: plan.approvedAgreement.invoiceId,
        receipt,
      };
    }

    const settings = await getSettingsInTransaction(client);
    const base = CLINIC_BASE_CURRENCY;
    const exchangeRate = rateFromSettings(settings, currency, base);
    if (exchangeRate === null) {
      throw new CanonicalPlanCaseRefusal(
        "plan_conflict",
        409,
        "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية.",
      );
    }

    const installmentNumber = Math.min(plan.progress.paidCount + 1, plan.installments.length || 1);
    const result = await recordPlanInstallmentInTransaction(client, {
      planId,
      patientId: plan.patientId,
      installmentNumber,
      planTitle: plan.title,
      amountMinor,
      currency,
      baseCurrency: base,
      exchangeRate,
      method,
      note,
      createdBy: identity.username,
      actorRole: identity.role,
      idempotencyKey,
      similarityReview,
    });
    if ("reason" in result) {
      throw new CanonicalPlanInstallmentRefusal(result, plan.baseCurrency);
    }
    return { kind: "installment" as const, result };
  });

  if (outcome.kind === "approved") {
    const hydrated = await hydrateCollectedAgreementPayments(outcome.receipt);
    return {
      body: { ...hydrated, invoiceId: outcome.invoiceId },
      status: hydrated.replayed ? 200 : 201,
    };
  }
  return {
    body: outcome.result,
    status: outcome.result.replayed ? 200 : 201,
  };
}

export async function commandCanonicalSetPlanStatus(
  session: VerifiedDurableSession,
  rawPlanId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  const planId = positiveId(rawPlanId);
  if (!planId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم الخطة غير صالح.");
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const status = source.status;
  if (status !== "active" && status !== "completed" && status !== "cancelled") {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "حالة غير معروفة.");
  }
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 300) : "";

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const { identity } = await assertPlanOwnerAndScope(client, handle, "clinical.plans.edit", planId);
    const done = await setPlanStatusWith(client, planId, status, {
      actor: identity.username,
      actorRole: identity.role,
      reason: reason || null,
    });
    if (done === "reason_required") {
      throw new CanonicalPlanCaseRefusal(
        "invalid_plan_input",
        400,
        status === "cancelled" ? "اكتب سبب إلغاء الخطة." : "اكتب سبب إعادة تفعيل الخطة الملغاة.",
      );
    }
    if (done === "not_found") throw new CanonicalPlanCaseRefusal("plan_not_found", 404, "الخطة غير موجودة.");
    return { ok: true };
  });
}

export async function commandCanonicalAddPlanItem(
  session: VerifiedDurableSession,
  rawPlanId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ totalMinor?: number }> {
  const planId = positiveId(rawPlanId);
  if (!planId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم الخطة غير صالح.");
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;

  const serviceId = positiveId(source.serviceId);
  if (!serviceId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "اختر الخدمة من الدليل.");
  const quantity = Math.round(Number(source.quantity ?? 1));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "العدد بين 1 و99.");
  }
  const toothCode = source.toothCode === null || source.toothCode === undefined || source.toothCode === ""
    ? null
    : Number(source.toothCode);
  if (toothCode !== null && !Number.isInteger(toothCode)) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم السن غير صالح.");
  }

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const { identity } = await assertPlanOwnerAndScope(client, handle, "clinical.plans.edit", planId);
    const service = await getServiceWith(client, serviceId);
    if (!service) throw new CanonicalPlanCaseRefusal("service_not_found", 404, "الخدمة غير موجودة في الدليل.");
    const planCurrency = await getPlanCurrencyWith(client, planId);
    if (!planCurrency) throw new CanonicalPlanCaseRefusal("plan_not_found", 404, "الخطة غير موجودة.");

    let unitPriceMinor: number;
    const overrides: InvoicePriceOverride[] = [];
    if (planCurrency === CLINIC_BASE_CURRENCY) {
      unitPriceMinor = service.priceMinor;
    } else {
      const priceRaw = source.price;
      if (priceRaw === undefined || priceRaw === null || String(priceRaw).trim() === "") {
        throw new CanonicalPlanCaseRefusal(
          "invalid_plan_input",
          400,
          `سعر البند بعملة الخطة (${planCurrency}) إلزامي — سعر الدليل بالعملة الأساسية لا يُنسخ إلى خطة بعملة اتفاق.`,
        );
      }
      const explicit = parseAmount(String(priceRaw), planCurrency);
      if (explicit === null || explicit <= 0) {
        throw new CanonicalPlanCaseRefusal(
          "invalid_plan_input",
          400,
          `اكتب سعرًا صحيحًا أكبر من صفر بعملة الخطة (${planCurrency}).`,
        );
      }
      unitPriceMinor = explicit;
      const settings = await getSettingsWith(client);
      const priceGrants = await staffOperationCapabilities(
        client,
        handle,
        "clinical.plans.edit",
        ["finance.price-increases.apply", "finance.discounts.apply", "finance.discounts.override"] as const,
      );
      const pricedService = agreementPricedService(service, planCurrency);
      const catalogMinor = invoiceCatalogPrice(pricedService, planCurrency);
      const decision = decideCanonicalProcedurePrice({
        serviceName: service.name,
        catalogMinor: catalogMinor ?? 0,
        priceConfigured: catalogMinor !== null,
        requestedMinor: explicit,
        reason: typeof source.priceReason === "string" ? source.priceReason : null,
        maxDiscountPercent: Number(settings["billing.max_discount_percent"]),
        capabilities: {
          canIncreasePrice: priceGrants.has("finance.price-increases.apply"),
          canApplyDiscount: priceGrants.has("finance.discounts.apply"),
          canOverrideDiscount: priceGrants.has("finance.discounts.override"),
        },
      });
      if (!decision.ok) {
        throw new CanonicalPlanCaseRefusal(
          decision.forbidden ? "plan_forbidden" : "invalid_plan_input",
          decision.forbidden ? 403 : 400,
          decision.message,
        );
      }
      if (decision.override) {
        overrides.push({ description: service.name, ...decision.override });
      }
    }

    const result = await addPlanItemWith(client, {
      planId,
      serviceId: service.id,
      serviceName: service.name,
      category: service.category,
      toothCode,
      surfaces: typeof source.surfaces === "string" ? source.surfaces : null,
      quantity,
      unitPriceMinor,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
      plannedVisitNumber: normalizeCount(source.plannedVisitNumber, 1, 30),
      billingRule: billingRuleFrom(source.billingRule),
      sessionCount: normalizeCount(source.sessionCount, 1, 30),
      doctorId: doctorIdFrom(source.doctorId),
    });
    if (!result.ok) {
      throw new CanonicalPlanCaseRefusal("plan_conflict", 409, result.message);
    }
    await insertAuditRow(client, {
      action: "plan.item_add",
      entity: "treatment_plan",
      entityId: planId,
      entityLabel: service.name,
      details: { الخدمة: service.name, الكمية: quantity, سعر_الوحدة: unitPriceMinor, العملة: planCurrency },
      actor: identity.username,
      actorRole: identity.role,
    });
    if (overrides.length > 0) {
      await insertAuditRow(client, {
        action: "plan.price_override",
        entity: "treatment_plan",
        entityId: planId,
        entityLabel: service.name,
        details: { العملة: planCurrency, أسعار_معدلة: formatPriceOverrides(overrides) },
        actor: identity.username,
        actorRole: identity.role,
      });
    }
    return { totalMinor: result.totalMinor };
  });
}

export async function commandCanonicalUpdatePlanItem(
  session: VerifiedDurableSession,
  rawPlanId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  const planId = positiveId(rawPlanId);
  if (!planId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم الخطة غير صالح.");
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const itemId = positiveId(source.itemId);
  if (!itemId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم البند غير صالح.");

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const { identity } = await assertPlanOwnerAndScope(client, handle, "clinical.plans.edit", planId);
    const result = await updatePlanItemWith(client, {
      planId,
      itemId,
      plannedVisitNumber: source.plannedVisitNumber !== undefined ? normalizeCount(source.plannedVisitNumber, 1, 30) : undefined,
      billingRule: source.billingRule !== undefined ? billingRuleFrom(source.billingRule) : undefined,
      sessionCount: source.sessionCount !== undefined ? normalizeCount(source.sessionCount, 1, 30) : undefined,
      doctorId: source.doctorId !== undefined ? doctorIdFrom(source.doctorId) : undefined,
      note: source.note !== undefined ? (typeof source.note === "string" ? source.note.slice(0, 300) : null) : undefined,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) throw new CanonicalPlanCaseRefusal("plan_conflict", 409, result.message);
    return { ok: true };
  });
}

export async function commandCanonicalRemovePlanItem(
  session: VerifiedDurableSession,
  rawPlanId: unknown,
  rawItemId: unknown,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  const planId = positiveId(rawPlanId);
  if (!planId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم الخطة غير صالح.");
  const itemId = positiveId(rawItemId);
  if (!itemId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم البند غير صالح.");

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const { identity } = await assertPlanOwnerAndScope(client, handle, "clinical.plans.edit", planId);
    const result = await removePlanItemWith(client, planId, itemId, {
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) throw new CanonicalPlanCaseRefusal("plan_conflict", 409, result.message);
    return { ok: true };
  });
}

export async function commandCanonicalPlanConsent(
  session: VerifiedDurableSession,
  rawPlanId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ status: 201; body: { totalMinor?: number; installments: number } } | { status: 409; body: { message: string } }> {
  const planId = positiveId(rawPlanId);
  if (!planId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم الخطة غير صالح.");
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;

  const count = Math.round(Number(source.count ?? 0));
  const wantsInstallments = Number.isFinite(count) && count >= 1;
  if (wantsInstallments && count > 60) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "عدد الأقساط بين 1 و60.");
  }
  const everyDays = Math.round(Number(source.everyDays ?? 30));
  if (wantsInstallments && (!Number.isFinite(everyDays) || everyDays < 1 || everyDays > 365)) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "المدة بين الأقساط بين 1 و365 يومًا.");
  }

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const { identity } = await assertPlanOwnerAndScope(client, handle, "clinical.plans.edit", planId);
    const consent = await recordPlanConsentWith(client, {
      planId,
      actor: identity.username,
      actorRole: identity.role,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
    });
    if (!consent.ok) throw new CanonicalPlanCaseRefusal("plan_conflict", 409, consent.message);

    if (!wantsInstallments) {
      return { status: 201 as const, body: { totalMinor: consent.totalMinor, installments: 0 } };
    }
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const firstDueDate = typeof source.firstDueDate === "string" && DATE_PATTERN.test(source.firstDueDate)
      ? source.firstDueDate
      : today;
    const scheduled = await schedulePlanInstallmentsWith(client, { planId, count, everyDays, firstDueDate });
    if (!scheduled.ok) {
      return { status: 409 as const, body: { message: `سُجّلت الموافقة، وتعذّرت الجدولة: ${scheduled.message}` } };
    }
    return { status: 201 as const, body: { totalMinor: consent.totalMinor, installments: scheduled.count ?? 0 } };
  });
}

export async function readCanonicalPendingProposals(session: VerifiedDurableSession) {
  return runCanonicalReadSnapshot(
    session,
    "read:plans.proposals",
    async (query, scope) => {
      const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
      const settings = await getSettingsWith(query);
      const followUpDays = followUpDaysFrom(settings["followup.proposal_days"]);
      const includeMoney = scope.granted("finance.invoices.view") || scope.granted("finance.patient-ledger.view");
      const clinicianPartyId = scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null;
      const rows = await listPendingProposalsWith(query, { includeMoney, clinicianPartyId });
      const proposals = sortProposals(
        rows.map((row) => ({
          ...row,
          timing: proposalTiming({ createdOn: row.createdOn, lastContactOn: row.lastContactOn, today, followUpDays }),
        })),
      );
      return { proposals, followUpDays, today };
    },
    { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 },
  );
}

export async function commandCanonicalProposalContact(
  session: VerifiedDurableSession,
  rawBody: unknown,
  pool: DbPool = getPool(),
) {
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const planId = positiveId(source.planId);
  if (!planId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم الخطة غير صالح.");
  const note = typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const { identity } = await assertPlanOwnerAndScope(client, handle, "clinical.plans.edit", planId);
    const saved = await recordProposalContactWith(client, {
      planId,
      note,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!saved.ok) {
      throw new CanonicalPlanCaseRefusal(
        saved.status === 404 ? "plan_not_found" : "plan_conflict",
        saved.status,
        saved.message,
      );
    }
    return saved;
  });
}

export async function commandCanonicalPlanReminders(
  session: VerifiedDurableSession,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<Record<string, unknown>> {
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;

  if (Array.isArray(source.planIds)) {
    const planIds = source.planIds.filter(
      (id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 2147483647,
    ) as number[];
    if (planIds.length === 0 || planIds.length !== source.planIds.length) {
      throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "حدد الخطط أولاً.");
    }
    if (planIds.length > 500) {
      throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "اختر 500 خطة كحد أقصى.");
    }
    return withStaffOperation(pool, session, "appointments.create", async (client, handle) => {
      const identity = await staffOperationIdentity(client, handle, "appointments.create");
      const patientScope = await staffOperationPatientScope(client, handle, "appointments.create");
      if (patientScope.kind === "none") {
        throw new CanonicalPlanCaseRefusal("plan_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
      }
      const clinicianPartyId = patientScope.kind === "own" ? patientScope.clinicianPartyId : null;
      const result = await recordPlanInstallmentRemindersWith(client, {
        planIds,
        bulk: true,
        actor: identity.username,
        actorRole: identity.role,
        clinicianPartyId,
      });
      return { success: true, ...result };
    });
  }

  const planId = Number(source.planId);
  if (!Number.isSafeInteger(planId) || planId <= 0 || planId > 2147483647) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "معرف الخطة غير صحيح.");
  }
  const installmentNumber = source.installmentNumber === undefined ? undefined : Number(source.installmentNumber);
  if (
    installmentNumber !== undefined
    && (!Number.isSafeInteger(installmentNumber) || installmentNumber <= 0 || installmentNumber > 2147483647)
  ) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم القسط غير صحيح.");
  }

  return withStaffOperation(pool, session, "appointments.create", async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "appointments.create");
    const patientScope = await staffOperationPatientScope(client, handle, "appointments.create");
    if (patientScope.kind === "none") {
      throw new CanonicalPlanCaseRefusal("plan_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
    }
    const clinicianPartyId = patientScope.kind === "own" ? patientScope.clinicianPartyId : null;
    const res = await recordPlanInstallmentRemindersWith(client, {
      planIds: [planId],
      installmentNumber,
      bulk: false,
      actor: identity.username,
      actorRole: identity.role,
      clinicianPartyId,
    });
    if (res.updatedCount === 0) {
      throw new CanonicalPlanCaseRefusal("plan_not_found", 404, "الخطة أو القسط غير موجود.");
    }
    return {
      success: true,
      planId,
      installmentNumber,
      lastReminderAt: res.lastReminderAt,
    };
  });
}

export async function readCanonicalPatientCases(
  session: VerifiedDurableSession,
  rawPatientId: unknown,
) {
  const patientId = positiveId(rawPatientId);
  if (!patientId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم مريض غير صالح.");

  return runCanonicalReadSnapshot(
    session,
    "read:patients.record",
    async (query, scope) => {
      const { rows: [exists] } = await query.query<{ id: number }>(`SELECT id FROM patients WHERE id = $1`, [patientId]);
      if (!exists) throw new CanonicalPlanCaseRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
      if (
        scope.patientScope.kind === "own"
        && !(await patientInDoctorScopeWith(query, scope.patientScope.clinicianPartyId, patientId))
      ) {
        throw new CanonicalPlanCaseRefusal("patient_not_found", 404, "لا يوجد مريض بهذا الرقم ضمن مرضاك.");
      }

      const planVisible = scope.granted("clinical.plans.view");
      const cases = await listPatientCasesWith(query, patientId);
      const problems = await listPatientProblemsWith(query, patientId);
      const plan = planVisible ? await listCasePlanItemsWith(query, patientId) : { items: [], dependencies: [] };
      return { cases, problems, items: plan.items, dependencies: plan.dependencies, planVisible };
    },
    { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 },
  );
}

export async function commandCanonicalCreateCase(
  session: VerifiedDurableSession,
  rawPatientId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
) {
  const patientId = positiveId(rawPatientId);
  if (!patientId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم مريض غير صالح.");
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const draft = checkCaseDraft(source);
  if (!draft.ok) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, draft.message);

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const { identity, patientScope } = await lockPatientAndAssertScope(
      client,
      handle,
      "clinical.plans.edit",
      patientId,
      "patient_not_found",
      "لا يوجد مريض بهذا الرقم.",
    );
    const clinicianPartyId = await staffOperationClinician(client, handle, "clinical.plans.edit");
    const responsiblePartyId = draft.value.responsiblePartyId ?? clinicianPartyId ?? null;
    if (
      patientScope.kind === "own"
      && responsiblePartyId !== null
      && responsiblePartyId !== patientScope.clinicianPartyId
    ) {
      throw new CanonicalPlanCaseRefusal(
        "plan_forbidden",
        403,
        "لا يمكن للطبيب المقيّد بنطاق مرضاه إسناد المسؤولية الأولية لطبيب آخر.",
      );
    }

    const result = await createClinicalCaseWith(client, {
      ...draft.value,
      responsiblePartyId,
      patientId,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      const mapping = {
        no_patient: ["patient_not_found", 404, "لا يوجد مريض بهذا الرقم."],
        bad_responsible: ["invalid_plan_input", 400, "الطبيب المسؤول يجب أن يكون طبيبًا مسجّلًا."],
        bad_ortho: ["invalid_plan_input", 400, "حالة التقويم لا تخص هذا المريض."],
        already_bridged: ["plan_conflict", 409, "حالة التقويم هذه مربوطة من قبل."],
      } as const;
      const [code, status, message] = mapping[result.reason];
      throw new CanonicalPlanCaseRefusal(code, status, message);
    }
    return result.case;
  });
}

export async function commandCanonicalChangeCaseStatus(
  session: VerifiedDurableSession,
  rawCaseId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
) {
  const id = positiveId(rawCaseId);
  if (!id) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم حالة غير صالح.");
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const change = checkCaseStatusChange(source);
  if (!change.ok) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, change.message);

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const patientScope = await staffOperationPatientScope(client, handle, "clinical.plans.edit");
    if (patientScope.kind === "none") {
      throw new CanonicalPlanCaseRefusal("plan_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
    }
    const existing = await getClinicalCaseWith(client, id);
    if (!existing) throw new CanonicalPlanCaseRefusal("case_not_found", 404, "لا توجد حالة بهذا الرقم.");
    const { identity } = await lockPatientAndAssertScope(
      client,
      handle,
      "clinical.plans.edit",
      existing.patientId,
      "case_not_found",
      "لا توجد حالة بهذا الرقم.",
    );
    const result = await changeClinicalCaseStatusWith(client, {
      id,
      ...change.value,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      if (result.reason === "not_found") throw new CanonicalPlanCaseRefusal("case_not_found", 404, "لا توجد حالة بهذا الرقم.");
      if (result.reason === "ortho_managed") {
        throw new CanonicalPlanCaseRefusal("plan_conflict", 409, "حالة التقويم تُدار وتُغلق من «التقويم وسيفالو».");
      }
      throw new CanonicalPlanCaseRefusal(
        "plan_conflict",
        409,
        "لا يمكن نقل الحالة إلى هذه الحالة — المنتهية لا تُعاد فتحها؛ افتح حالةً جديدة.",
      );
    }
    return result.case;
  });
}

export async function commandCanonicalSetPlanItemCase(
  session: VerifiedDurableSession,
  rawItemId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  const itemId = positiveId(rawItemId);
  if (!itemId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم بند غير صالح.");
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const rawCase = source.caseId;
  const caseId = rawCase === null || rawCase === undefined || rawCase === "" ? null : positiveId(rawCase);
  if (rawCase !== null && rawCase !== undefined && rawCase !== "" && caseId === null) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "الحالة غير صالحة.");
  }
  const rawPriority = source.priority;
  const priority = rawPriority === null || rawPriority === undefined || rawPriority === "" ? null : Number(rawPriority);
  if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 999)) {
    throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "الأولوية رقمٌ من ١ إلى ٩٩٩ (الأصغر أولًا).");
  }

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const patientScope = await staffOperationPatientScope(client, handle, "clinical.plans.edit");
    if (patientScope.kind === "none") {
      throw new CanonicalPlanCaseRefusal("plan_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
    }
    const patientId = await getPlanItemPatientWith(client, itemId);
    if (!patientId) throw new CanonicalPlanCaseRefusal("item_not_found", 404, "لا يوجد بند بهذا الرقم.");
    const { identity } = await lockPatientAndAssertScope(
      client,
      handle,
      "clinical.plans.edit",
      patientId,
      "item_not_found",
      "لا يوجد بند بهذا الرقم.",
    );
    const result = await setPlanItemCaseWith(client, {
      itemId,
      caseId,
      priority,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      if (result.reason === "billed_case_lock") {
        throw new CanonicalPlanCaseRefusal(
          "plan_conflict",
          409,
          "لا يمكن تغيير الحالة المرتبطة ببند صدرت له فاتورة حفاظًا على السجل المالي والعمولات. يمكنك تعديل الأولوية فقط.",
        );
      }
      if (result.reason === "not_found") throw new CanonicalPlanCaseRefusal("item_not_found", 404, "لا يوجد بند بهذا الرقم.");
      throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "الحالة المختارة لا تخص هذا المريض.");
    }
    return { ok: true };
  });
}

export async function commandCanonicalAddPlanItemDependency(
  session: VerifiedDurableSession,
  rawItemId: unknown,
  rawBody: unknown,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  const itemId = positiveId(rawItemId);
  if (!itemId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم بند غير صالح.");
  const source = (rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const draft = checkDependencyDraft(itemId, source);
  if (!draft.ok) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, draft.message);

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const patientScope = await staffOperationPatientScope(client, handle, "clinical.plans.edit");
    if (patientScope.kind === "none") {
      throw new CanonicalPlanCaseRefusal("plan_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
    }
    const patientId = await getPlanItemPatientWith(client, itemId);
    if (!patientId) throw new CanonicalPlanCaseRefusal("item_not_found", 404, "لا يوجد بند بهذا الرقم.");
    const { identity } = await lockPatientAndAssertScope(
      client,
      handle,
      "clinical.plans.edit",
      patientId,
      "item_not_found",
      "لا يوجد بند بهذا الرقم.",
    );
    const result = await addPlanItemDependencyInTransaction(client, {
      itemId,
      ...draft.value,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) {
      const mapping = {
        not_found: ["item_not_found", 404, "لا يوجد بند بهذا الرقم."],
        other_patient: ["invalid_plan_input", 400, "البندان لمريضين مختلفين."],
        cycle: ["plan_conflict", 409, "هذا الاعتماد يصنع دورة — كلٌّ من البندين سينتظر الآخر."],
        exists: ["plan_conflict", 409, "هذا الاعتماد موجود من قبل."],
      } as const;
      const [code, status, message] = mapping[result.reason];
      throw new CanonicalPlanCaseRefusal(code, status, message);
    }
    return { ok: true };
  });
}

export async function commandCanonicalRemovePlanItemDependency(
  session: VerifiedDurableSession,
  rawItemId: unknown,
  rawRequiresId: unknown,
  pool: DbPool = getPool(),
): Promise<{ ok: true }> {
  const itemId = positiveId(rawItemId);
  if (!itemId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "رقم بند غير صالح.");
  const requiresItemId = positiveId(rawRequiresId);
  if (!requiresItemId) throw new CanonicalPlanCaseRefusal("invalid_plan_input", 400, "حدّد البند المطلوب المراد إزالته.");

  return withStaffOperation(pool, session, "clinical.plans.edit", async (client, handle) => {
    const patientScope = await staffOperationPatientScope(client, handle, "clinical.plans.edit");
    if (patientScope.kind === "none") {
      throw new CanonicalPlanCaseRefusal("plan_forbidden", 403, "لا تملك صلاحية الوصول لملفات المرضى.");
    }
    const patientId = await getPlanItemPatientWith(client, itemId);
    if (!patientId) throw new CanonicalPlanCaseRefusal("item_not_found", 404, "لا يوجد بند بهذا الرقم.");
    const { identity } = await lockPatientAndAssertScope(
      client,
      handle,
      "clinical.plans.edit",
      patientId,
      "item_not_found",
      "لا يوجد بند بهذا الرقم.",
    );
    const result = await removePlanItemDependencyWith(client, {
      itemId,
      requiresItemId,
      actor: identity.username,
      actorRole: identity.role,
    });
    if (!result.ok) throw new CanonicalPlanCaseRefusal("item_not_found", 404, "لا يوجد هذا الاعتماد.");
    return { ok: true };
  });
}

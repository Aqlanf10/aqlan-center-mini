import { isRetiredCollectionKey, retiredCollectionRefusal } from "@/lib/collection-attempts";
import { parseSimilarCollectionReviewHeader, similarCollectionRefusal, SimilarCollectionReviewRequired, SIMILAR_COLLECTION_REVIEW_HEADER } from "@/lib/similar-collection";
import { collectApprovedAgreement } from "@/lib/approved-agreements";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, getPlan, getSettings, recordPlanInstallment, setPlanStatus } from "@/lib/db";
import { isCurrency, parseAmount, type Currency, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency-key";
import { canHandleMoney } from "@/lib/roles";
import { rateFromSettings } from "@/lib/settings";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalPlanInstallmentOutcome, CanonicalPlanRefusal, commandCanonicalPlanCollection, commandCanonicalPlanStatus } from "@/lib/canonical-plan-writes";
import type { SimilarCollectionReview } from "@/lib/similar-collection";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** The legacy instalment writer's refusals, answered identically on both runtimes. */
function installmentReasonResponse(reason: string, planCurrency: string, recoveryInvoiceIds?: number[], headers?: HeadersInit): NextResponse {
  const init = (status: number) => ({ status, ...(headers ? { headers } : {}) });
  if (reason === "issued_installment_recovery_required" || reason === "installment_recovery_review_required") {
    return NextResponse.json({
      reason,
      message: reason === "issued_installment_recovery_required"
        ? "يوجد قسط مُصدر عُكس قبضه. اختر إعادة تحصيل الفاتورة الأصلية من الحساب؛ لا تُصدر قسطًا جديدًا."
        : "يوجد قسط مُصدر يحتاج مراجعة ربطه قبل التحصيل. راجع المدير؛ لا تُصدر فاتورة بديلة.",
      ...(recoveryInvoiceIds ? { recoveryInvoiceIds } : {}),
    }, init(409));
  }
  if (reason === "plan_financial_history_requires_review") {
    return NextResponse.json({ reason, message: "الخطة تحتوي علاجًا ذا سجل مالي أو اتفاق تاريخي؛ لا تُصدر قسطًا جديدًا له. اختر الفاتورة القائمة أو الرصيد السابق وراجع الربط المالي." }, init(409));
  }
  if (reason === "inactive_plan") return NextResponse.json({ message: "الخطة غير جارية — لا يمكن تسجيل تحصيل جديد عليها." }, init(409));
  if (reason === "idempotency_conflict") return NextResponse.json({ message: "مفتاح الإعادة مستعمل بعملية مختلفة — مفتاح واحد لعملية واحدة." }, init(409));
  if (reason === "cross_currency_not_supported") {
    return NextResponse.json({ message: `القسط بعملةٍ مختلفة عن عملة الخطة (${planCurrency}) غير مدعوم — حصّل بعملة الاتفاق نفسها.` }, init(409));
  }
  return NextResponse.json({ message: "لا توجد وردية مفتوحة. افتح الوردية من شاشة الصندوق أولًا." }, init(409));
}

type CollectionInput = { idempotencyKey: string; currency: Currency; amountMinor: number; method: "cash" | "transfer"; note: string | null; similarityReview: SimilarCollectionReview };
/** The collection's request key as the legacy route reads it, before the plan is looked up. */
function parseCollectionKey(request: Request, headers?: HeadersInit): string | NextResponse {
  const init = (status: number) => ({ status, ...(headers ? { headers } : {}) });
  /* (FIN-1) مفتاح الإعادة كما في /api/payments: انقطاع الرد ثم ضغطٌ ثانٍ على «تحصيل» يُعيد
     السند الأول لا يُنشئ ثانيًا. */
  const idempotencyKeyRaw = request.headers.get("idempotency-key");
  const idempotencyKey = idempotencyKeyRaw && idempotencyKeyRaw.trim() ? idempotencyKeyRaw.trim() : null;
  if (!idempotencyKey) {
    return NextResponse.json(
      { reason: "idempotency_key_required", message: "مفتاح الإعادة (Idempotency-Key) مطلوب للتحصيل. أعد إرسال الطلب المحفوظ بالمفتاح نفسه." },
      init(400),
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return NextResponse.json(
      { message: "مفتاح الإعادة (Idempotency-Key) غير صالح: ٨–١٢٨ محرفًا من حروف وأرقام و . _ : -" },
      init(400),
    );
  }
  return idempotencyKey;
}
/** The collection's fields as the legacy route reads them, after the plan is looked up
 * (currency, amount, method, note, similar-collection review); a refusal is the legacy response. */
function parseCollectionFields(request: Request, source: Record<string, unknown>, idempotencyKey: string, headers?: HeadersInit): CollectionInput | NextResponse {
  const init = (status: number) => ({ status, ...(headers ? { headers } : {}) });
  const currency = source.currency;
  if (!isCurrency(currency)) return NextResponse.json({ message: "اختر العملة." }, init(400));
  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor === 0) return NextResponse.json({ message: "اكتب مبلغًا أكبر من صفر." }, init(400));
  const method = source.method === "transfer" ? "transfer" : "cash";
  const note = typeof source.note === "string" && source.note.trim() ? source.note.trim().slice(0, 300) : null;
  const similarityReview = parseSimilarCollectionReviewHeader(request.headers.get(SIMILAR_COLLECTION_REVIEW_HEADER));
  if (!similarityReview) return NextResponse.json({ message: "مراجعة السندات المشابهة المرسلة غير صالحة. أعد فتح نافذة التحصيل." }, init(400));
  return { idempotencyKey, currency, amountMinor, method, note, similarityReview };
}

/** M2 slice 94b (G4-4, G4-8): the collection on a plan by finance.payments.collect. */
async function canonicalCollection(request: Request, context: { params: Promise<{ id: string }> }, session: Parameters<typeof commandCanonicalPlanCollection>[0]) {
  const planId = Number((await context.params).id);
  if (!Number.isInteger(planId) || planId <= 0) return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400, headers: NO_STORE });
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const key = parseCollectionKey(request, NO_STORE);
  if (key instanceof NextResponse) return key;
  const input = parseCollectionFields(request, (body ?? {}) as Record<string, unknown>, key, NO_STORE);
  if (input instanceof NextResponse) return input;
  try {
    const result = await commandCanonicalPlanCollection(session, planId, input);
    return NextResponse.json(result.body, { status: result.body.replayed ? 200 : 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof CanonicalPlanInstallmentOutcome) return installmentReasonResponse(error.reason, error.planCurrency, error.recoveryInvoiceIds, NO_STORE);
    if (error instanceof CanonicalPlanRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
    if (error instanceof SimilarCollectionReviewRequired) return NextResponse.json(similarCollectionRefusal(error), { status: 409, headers: NO_STORE });
    if (isRetiredCollectionKey(error)) return NextResponse.json(retiredCollectionRefusal(), { status: 409, headers: NO_STORE });
    if (error instanceof DebtRepaymentError) return NextResponse.json({ message: error.message, code: error.code }, { status: error.code === "unauthorized" ? 403 : error.code === "invalid" ? 400 : 409, headers: NO_STORE });
    return canonicalPatientReadFailure(error, "تعذّر تسجيل القسط. أعد المحاولة.");
  }
}

/** تسجيل قسط: فاتورة بقيمته ودفعة عليها في معاملة واحدة. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") return canonicalCollection(request, context, selected.handle);
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "التحصيل للإدارة والاستقبال." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const planId = Number(rawId);
  if (!Number.isInteger(planId) || planId <= 0) {
    return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const key = parseCollectionKey(request);
  if (key instanceof NextResponse) return key;

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const plan = await getPlan(planId, today);
  if (!plan) return NextResponse.json({ message: "الخطة غير موجودة." }, { status: 404 });
  // The writer checks status under the plan lock, after successful-key replay.
  // Rejecting here would break retries of receipts issued before plan closure.

  const input = parseCollectionFields(request, source, key);
  if (input instanceof NextResponse) return input;
  const { idempotencyKey, currency, amountMinor, method, note, similarityReview } = input;

  try {
    if (plan.approvedAgreement) {
      const result = await collectApprovedAgreement({planId,amountMinor,currency,method,note,idempotencyKey:idempotencyKey??"",session},{similarityReview});
      return NextResponse.json({...result,invoiceId:plan.approvedAgreement.invoiceId},{status:result.replayed?200:201});
    }
    const settings = await getSettings();
    // (TD-05) الأساس دستوري من الكود — وعملة الفاتورة من عملة الخطة نفسها.
    const base = CLINIC_BASE_CURRENCY;
    const exchangeRate = rateFromSettings(settings, currency, base);
    if (exchangeRate === null) {
      return NextResponse.json(
        { message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية." },
        { status: 409 },
      );
    }

    // رقم القسط يُشتقّ من عدد المسدَّد لا يُقبل من الواجهة: رقمٌ مكرر يجعل سندين
    // يحملان «قسط 3» ولا يُعرف أيّهما.
    const installmentNumber = Math.min(plan.progress.paidCount + 1, plan.installments.length || 1);
    const result = await recordPlanInstallment({
      planId, patientId: plan.patientId, installmentNumber, planTitle: plan.title,
      amountMinor, currency, baseCurrency: base, exchangeRate, method, note,
      createdBy: session.username, actorRole: session.role, idempotencyKey, similarityReview,
    });
    if ("reason" in result) return installmentReasonResponse(result.reason, plan.baseCurrency, "recoveryInvoiceIds" in result ? result.recoveryInvoiceIds : undefined);
    // إعادةٌ لسندٍ سُجّل سابقًا: 200 لا 201 — كما في /api/payments.
    return NextResponse.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    if(error instanceof SimilarCollectionReviewRequired)return NextResponse.json(similarCollectionRefusal(error),{status:409});
    if (isRetiredCollectionKey(error)) return NextResponse.json(retiredCollectionRefusal(), { status: 409 });
    if(error instanceof DebtRepaymentError)return NextResponse.json({message:error.message,code:error.code},{status:error.code==="unauthorized"?403:error.code==="invalid"?400:409});
    return NextResponse.json({ message: "تعذّر تسجيل القسط. أعد المحاولة." }, { status: 500 });
  }
}

/** M2 slice 94b (G4-8): the plan status by clinical.plans.edit inside the patient scope. */
async function canonicalStatus(request: Request, context: { params: Promise<{ id: string }> }, session: Parameters<typeof commandCanonicalPlanStatus>[0]) {
  const planId = Number((await context.params).id);
  if (!Number.isInteger(planId) || planId <= 0) return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400, headers: NO_STORE });
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const status = (body as Record<string, unknown>)?.status;
  if (status !== "active" && status !== "completed" && status !== "cancelled") return NextResponse.json({ message: "حالة غير معروفة." }, { status: 400, headers: NO_STORE });
  const rawReason = (body as Record<string, unknown>)?.reason;
  const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 300) : "";
  try { return NextResponse.json(await commandCanonicalPlanStatus(session, planId, status, reason || null), { headers: NO_STORE }); }
  catch (error) {
    if (error instanceof CanonicalPlanRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
    return canonicalPatientReadFailure(error, "تعذّر تنفيذ الإجراء.");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") return canonicalStatus(request, context, selected.handle);
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const status = (body as Record<string, unknown>)?.status;
  if (status !== "active" && status !== "completed" && status !== "cancelled") {
    return NextResponse.json({ message: "حالة غير معروفة." }, { status: 400 });
  }

  /* (FIN-3) إلغاء الخطة أو إحياء خطةٍ ملغاة قرارٌ مسبَّب: بلا سببٍ مكتوب لا يُعرف لاحقًا لماذا
     توقّف اتفاقٌ مع مريض أو عاد. */
  const rawReason = (body as Record<string, unknown>)?.reason;
  const reason = typeof rawReason === "string" ? rawReason.trim().slice(0, 300) : "";

  try {
    const done = await setPlanStatus(id, status, {
      actor: session.username, actorRole: session.role, reason: reason || null,
    });
    if (done === "reason_required") {
      return NextResponse.json(
        { message: status === "cancelled" ? "اكتب سبب إلغاء الخطة." : "اكتب سبب إعادة تفعيل الخطة الملغاة." },
        { status: 400 },
      );
    }
    if (done === "not_found") return NextResponse.json({ message: "الخطة غير موجودة." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء." }, { status: 500 });
  }
}


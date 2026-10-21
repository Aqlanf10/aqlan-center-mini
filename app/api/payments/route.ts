import { collectApprovedAgreement } from "@/lib/approved-agreements";
import { DebtRepaymentError } from "@/lib/debt-installments-db";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getPayment, getPaymentByIdempotencyKey, getPlan, getSettings, isPlanFundedByAgreement, listPaymentsByDate, recordAudit, recordPayment, recordSettingsOwnedPayment, recordPlanInstallment, recordReversedInstallmentRecovery } from "@/lib/db";
import { parseRecoveryIntent } from "@/lib/reversed-installment-recovery";
import { isCurrency, parseAmount, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { CLINIC_TIME_ZONE } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney, canViewMoney } from "@/lib/roles";
import { rateFromSettings } from "@/lib/settings";
import { requireSession } from "@/lib/session";
import { IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency-key";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const requested = new URL(request.url).searchParams.get("date") ?? "";
  const date = DATE_PATTERN.test(requested)
    ? requested : clinicDateString(new Date(), CLINIC_TIME_ZONE);
  try {
    return NextResponse.json({ date, payments: await listPaymentsByDate(date) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المقبوضات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role) || (session.role === "cashier" && !session.financeAccess?.collectPayments)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  // A refund reverses a receipt. Only the manager may correct an issued receipt.
  if (source.kind === "refund" && session.role !== "admin") {
    return NextResponse.json({ message: "تصحيح سند القبض أو ردّه يتطلب صلاحية المدير." }, { status: 403 });
  }

  // Opt-in mode: replay/FX/audit belong to its canonical transaction. No generic
  // invoice-only write or post-commit audit may run for this purpose.
  const recovery = parseRecoveryIntent(body, request.headers.get("idempotency-key"));
  if (recovery.kind === "invalid") {
    return NextResponse.json({ reason: "invalid_recovery_request", message: "طلب إعادة تحصيل القسط غير صالح. اختر الفاتورة الأصلية ومبلغًا ومفتاح إعادة صالحين دون أهداف أو أسعار صرف إضافية." }, { status: 400 });
  }
  if (recovery.kind === "recovery") {
    try {
      const result = await recordReversedInstallmentRecovery({
        ...recovery.intent, idempotencyKey: recovery.idempotencyKey,
        createdBy: session.username, actorRole: session.role,
      });
      if (result.reason || !result.payment) {
        const messages: Record<string, string> = {
          invalid_recovery_request: "طلب إعادة تحصيل القسط غير صالح.",
          recovery_review_required: "ربط القسط المعكوس يحتاج مراجعة المدير قبل التحصيل. لا تُصدر قسطًا جديدًا بدلًا منه.",
          recovery_not_available: "لم تعد هذه الفاتورة متاحة لإعادة التحصيل. حدّث الحساب واختر هدفًا صالحًا.",
          recovery_exceeds_remaining: "المبلغ يتجاوز المتبقي على الفاتورة الأصلية. حدّث الحساب وراجع المبلغ.",
          recovery_account_credit_review: "المبلغ يتجاوز المستحق الفعلي على الحساب بهذه العملة أو يوجد رصيد دائن. راجع التسويات مع المدير قبل قبض المال؛ لا تُصدر قسطًا جديدًا.",
          recovery_target_changed: "تغيّر ربط الفاتورة الأصلية أثناء التحصيل. حدّث الحساب وراجع الهدف.",
          exchange_rate_required: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية.",
          idempotency_conflict: "مفتاح الإعادة مستعمل بعملية مختلفة — مفتاح واحد لعملية واحدة.",
          no_shift: "لا توجد وردية مفتوحة. افتح الوردية من شاشة المالية أولًا.",
          invalid_invoice: "الفاتورة لا تخص المريض أو غير صالحة.",
          cross_currency_not_supported: "حصّل الفاتورة بعملتها نفسها؛ التسوية بهذه العملة غير مدعومة.",
        };
        return NextResponse.json({ reason: result.reason, message: messages[result.reason ?? ""] ?? "تعذّرت إعادة تحصيل القسط. راجع الحساب قبل المحاولة." }, { status: result.reason === "invalid_recovery_request" ? 400 : 409 });
      }
      return NextResponse.json({ ...result.payment, idempotencyKey:recovery.idempotencyKey }, { status: result.replayed ? 200 : 201 });
    } catch {
      return NextResponse.json({ message: "تعذّر تسجيل الدفعة. أعد المحاولة بالمفتاح نفسه." }, { status: 500 });
    }
  }

  const patientId = Number(source.patientId);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }

  const currency = source.currency;
  if (!isCurrency(currency)) {
    return NextResponse.json({ message: "اختر العملة." }, { status: 400 });
  }

  const amountMinor = parseAmount(String(source.amount ?? ""), currency);
  if (amountMinor === null || amountMinor === 0) {
    return NextResponse.json({ message: "اكتب مبلغًا أكبر من صفر." }, { status: 400 });
  }

  const kind = source.kind === "refund" ? "refund" : "payment";
  const method = source.method === "transfer" ? "transfer" : "cash";
  const invoiceIdRaw = Number(source.invoiceId);
  const invoiceId = Number.isInteger(invoiceIdRaw) && invoiceIdRaw > 0 ? invoiceIdRaw : null;
  /* (TD-05 owner review — Finding 5) خطة الاتفاق هدف تسوية صريح للدفع على
   * الحساب: الدفعة المقدَّمة قبل الفوترة تُقيَّد على خطتها فتسوّي دلو عملتها. */
  const planIdRaw = Number(source.planId);
  const planId = Number.isInteger(planIdRaw) && planIdRaw > 0 ? planIdRaw : null;
  /* (P1-5ب) هدفٌ ثالث: الرصيد الافتتاحي بعملته — رصيد المركز القديم يبقى بعملته. */
  const openingCurrency = isCurrency(source.openingCurrency) ? source.openingCurrency : null;
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  if ([invoiceId, planId, openingCurrency].filter((target) => target !== null).length > 1) {
    return NextResponse.json(
      { message: "هدفٌ واحد للدفعة: فاتورة أو خطة أو رصيد سابق — لا أكثر من واحد." },
      { status: 400 },
    );
  }

  /* (TD-05 owner review — Finding 5) الدفع الأجنبي بلا هدف يُرفض من الباب:
   * لا فاتورة ولا خطة ⇒ كان سيُقيَّد على دلو الأساس بصمت فيخفض الريال
   * بدفعةٍ دولاريةٍ «حرة» — رفضٌ واضحٌ يطلب هدفًا صريحًا. */
  if (kind === "payment" && invoiceId === null && planId === null && openingCurrency === null
    && currency !== CLINIC_BASE_CURRENCY) {
    return NextResponse.json(
      {
        message: "الدفعة بعملة أجنبية تتطلب هدفًا صريحًا (فاتورة أو خطة أو رصيد سابق بعملتها) — لا تُقيَّد على الحساب بالعملة الأساسية بصمت.",
      },
      { status: 400 },
    );
  }

  /* (P1.5) مفتاح الإعادة من ترويسة الطلب: النقر المزدوج/إعادة الإرسال/انقطاع
     الشبكة كلها تنتج الطلب نفسه بالمفتاح نفسه → سند واحد فقط، والثاني replay
     يعيد السند الأول نفسه (200 لا 201). الترويسة إلزامية قبل أي كتابة مالية. */
  const idempotencyKeyRaw = request.headers.get("idempotency-key");
  const idempotencyKey = idempotencyKeyRaw && idempotencyKeyRaw.trim()
    ? idempotencyKeyRaw.trim() : null;
  if (!idempotencyKey) {
    return NextResponse.json(
      { reason: "idempotency_key_required", message: "مفتاح الإعادة (Idempotency-Key) مطلوب للتحصيل. أعد إرسال الطلب المحفوظ بالمفتاح نفسه." },
      { status: 400 },
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return NextResponse.json(
      { message: "مفتاح الإعادة (Idempotency-Key) غير صالح: ٨–١٢٨ محرفًا من حروف وأرقام و . _ : -" },
      { status: 400 },
    );
  }

  const reversalOfRaw = Number(source.reversalOfId);
  const reversalOfId = Number.isInteger(reversalOfRaw) && reversalOfRaw > 0 ? reversalOfRaw : null;

  /* (P1-FIX-5) الردّ بلا سند أصلي مرفوض من الباب: لا ردّ «حُرّ». */
  if (kind === "refund" && reversalOfId === null) {
    return NextResponse.json(
      { message: "الردّ يتطلب تحديد السند الأصلي (reversalOfId) — لا يُردّ مال بلا أصل." },
      { status: 400 },
    );
  }

  const settings = await getSettings();
  // (TD-05) الأساس دستوري من الكود — والإعدادات لأسعار الصرف.
  const base = CLINIC_BASE_CURRENCY;
  const savedPayment=idempotencyKey?await getPaymentByIdempotencyKey(idempotencyKey):null;
  const exchangeRate = savedPayment?.patientId===patientId&&savedPayment.createdBy===session.username&&savedPayment.currency===currency
    ?savedPayment.exchangeRate:rateFromSettings(settings, currency, base);
  const exchangeRateRequired = (includeReason = false) => NextResponse.json(
    { ...(includeReason ? { reason: "exchange_rate_required" } : {}), message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية." },
    { status: 409 },
  );

  /* (BILL-1 — قرار المالك: «القسط وحده يفوتر») دفعةٌ على خطةٍ ممولة بالأقساط من باب القبض العام
     تُسجَّل **قسطًا بفاتورته** — المسار نفسه لزر «سجّل القسط» (recordPlanInstallment) — لا دفعةً
     بلا فاتورة: جلسات هذه الخطط مشمولة لا تُفوتر، فلو بقيت الدفعة بلا فاتورة لما فُوتر الاتفاق أبدًا.
     شكل الاستجابة كما هو (سند القبض). الخطط الأخرى والردود وبقية الأهداف بلا تغيير. */
  if (kind === "payment" && planId !== null) {
    try {
      if (await isPlanFundedByAgreement(planId, patientId)) {
        // Keep the specialized installment/approved-collection FX gate unchanged.
        if (exchangeRate === null) return exchangeRateRequired();
        const plan = await getPlan(planId, clinicDateString(new Date(), CLINIC_TIME_ZONE));
        if (plan && plan.patientId === patientId) {
          if(plan.approvedAgreement) {
            const result=await collectApprovedAgreement({planId,amountMinor,currency,method:method==="transfer"?"transfer":"cash",note,idempotencyKey:idempotencyKey??"",session});
            // Split receipts are one logical collection, not one payment for the whole amount.
            // The first receipt remains the backward-compatible top-level identity.
            const split="collection" in result && result.collection && "payments" in result && Array.isArray(result.payments);
            return NextResponse.json({
              ...result.payment,idempotencyKey,
              ...(split?{
                collection:{
                  kind:"approved_agreement_split_v1",...result.collection,
                  receipts:result.payments,
                },
                paymentIds:result.paymentIds,
                allocations:result.collection.allocations,
                collectionAmountMinor:result.collection.amountMinor,
              }:{}),
            },{status:result.replayed?200:201});
          }
          const installmentNumber = Math.min(plan.progress.paidCount + 1, plan.installments.length || 1);
          const result = await recordPlanInstallment({
            planId, patientId, installmentNumber, planTitle: plan.title,
            amountMinor, currency, baseCurrency: base, exchangeRate, method, note,
            createdBy: session.username, actorRole: session.role, idempotencyKey,
          });
          if ("reason" in result) {
            const messages = {
              inactive_plan: "الخطة غير جارية — لا يمكن تسجيل تحصيل جديد عليها.",
              no_shift: "لا توجد وردية مفتوحة. افتح الوردية من شاشة المالية أولًا.",
              cross_currency_not_supported: `القسط بعملةٍ مختلفة عن عملة الخطة (${plan.baseCurrency}) غير مدعوم — حصّل بعملة الاتفاق نفسها.`,
              idempotency_conflict: "مفتاح الإعادة مستعمل بعملية مختلفة — مفتاح واحد لعملية واحدة.",
              issued_installment_recovery_required: "يوجد قسط مُصدر عُكس قبضه. اختر إعادة تحصيل الفاتورة الأصلية من الحساب؛ لا تُصدر قسطًا جديدًا.",
              plan_financial_history_requires_review: "الخطة تحتوي علاجًا ذا سجل مالي أو اتفاق تاريخي؛ لا تُصدر قسطًا جديدًا له. اختر الفاتورة القائمة أو الرصيد السابق وراجع الربط المالي.",
              installment_recovery_review_required: "يوجد قسط مُصدر يحتاج مراجعة ربطه قبل التحصيل. راجع المدير؛ لا تُصدر فاتورة بديلة.",
            } as const;
            return NextResponse.json({ reason: result.reason, message: messages[result.reason], ...("recoveryInvoiceIds" in result ? { recoveryInvoiceIds: result.recoveryInvoiceIds } : {}) }, { status: 409 });
          }
          // (TD-06) سطر التدقيق يُكتب داخل recordPlanInstallment في معاملة السند نفسها.
          const payment = await getPayment(result.paymentId);
          return NextResponse.json({ ...payment, idempotencyKey }, { status: result.replayed ? 200 : 201 });
        }
      }
    } catch (error) {
      if(error instanceof DebtRepaymentError)return NextResponse.json({message:error.message,code:error.code},{status:error.code==="unauthorized"?403:error.code==="invalid"?400:409});
      return NextResponse.json({ message: "تعذّر تسجيل القسط. أعد المحاولة." }, { status: 500 });
    }
  }

  // Ordinary receipts must not silently discard a caller-supplied reversal link.
  if (kind === "payment" && reversalOfId !== null) {
    return NextResponse.json(
      { message: "السند المُراد ردّه غير موجود، أو لا يخص المريض، أو ليس دفعة أصلية." },
      { status: 409 },
    );
  }

  try {
    const receiptInput = {
      patientId, invoiceId, planId, openingCurrency, amountMinor, currency,
      baseCurrency: base, method, note, createdBy: session.username,
      idempotencyKey, actorRole: session.role,
    };
    // Only ordinary HTTP receipts use settings-owned compatibility. Refunds
    // retain their inherited origin snapshot and their existing route FX gate.
    if (kind === "refund" && exchangeRate === null) return exchangeRateRequired();
    const result = kind === "payment"
      ? await recordSettingsOwnedPayment(receiptInput, settings)
      : await recordPayment({ ...receiptInput, kind, exchangeRate: exchangeRate!, reversalOfId });
    const { payment, reason, replayed } = result;
    const acknowledgmentEvidence = "acknowledgmentEvidence" in result ? result.acknowledgmentEvidence : undefined;
    if (reason === "exchange_rate_required") return exchangeRateRequired(true);
    if (reason === "issued_installment_recovery_required" || reason === "installment_recovery_review_required") {
      return NextResponse.json({ reason, message: reason === "issued_installment_recovery_required"
        ? "يوجد قسط معكوس بفاتورته الأصلية. لم يُسجّل قبض جديد؛ يلزم مسار إعادة تحصيل الفاتورة الأصلية. لا تكرر القبض أو تُصدر قسطًا جديدًا."
        : "تاريخ القسط المعكوس يحتاج مراجعة المدير. لم يُسجّل قبض جديد؛ لا تكرر التحصيل أو تُصدر قسطًا آخر." }, { status: 409 });
    }
    if (reason === "invalid_invoice") {
      return NextResponse.json({ message: "الفاتورة لا تخص المريض أو غير صالحة." }, { status: 409 });
    }
    if (reason === "inactive_plan") {
      return NextResponse.json({ message: "الخطة غير جارية — لا يمكن تسجيل تحصيل جديد عليها." }, { status: 409 });
    }
    if (reason === "invalid_plan_target") {
      return NextResponse.json({ message: "الخطة غير متاحة كهدف لتحصيل جديد؛ تأكد من المريض واختر الفاتورة القائمة أو الرصيد السابق للعلاج التاريخي." }, { status: 409 });
    }
    if (reason === "invalid_opening_target") {
      return NextResponse.json({ message: "لا يوجد على المريض رصيد سابق بهذه العملة." }, { status: 409 });
    }
    if (reason === "reversal_target_conflict") {
      return NextResponse.json(
        {
          message:
            "هدف التسوية المرسل يخالف هدف السند الأصلي — الردّ يسوّي حيث سُدِّد الأصل، لا حيث يقول الطلب.",
        },
        { status: 409 },
      );
    }
    /* (TD-05 second owner review — Finding 8) الحارس الكانوني في الخدمة قد
       يصل إلى هنا إن فُتح بابٌ جديد بلا حارس الواجهة — الرسالة نفسها. */
    if (reason === "multiple_payment_targets") {
      return NextResponse.json(
        { message: "هدفٌ واحد للدفعة: فاتورة أو خطة أو رصيد سابق — لا أكثر من واحد." },
        { status: 400 },
      );
    }
    if (reason === "foreign_on_account_requires_target") {
      return NextResponse.json(
        {
          message:
            "الدفعة بعملة أجنبية تتطلب هدفًا صريحًا (فاتورة أو خطة) — لا تُقيَّد على الحساب بالعملة الأساسية بصمت.",
        },
        { status: 400 },
      );
    }
    if (reason === "invalid_reversal") {
      return NextResponse.json(
        { message: "السند المُراد ردّه غير موجود، أو لا يخص المريض، أو ليس دفعة أصلية." },
        { status: 409 },
      );
    }
    if (reason === "cross_currency_not_supported") {
      return NextResponse.json(
        { message: "الدفع بعملةٍ مختلفة عن فاتورةٍ أو رصيدٍ بعملة اتفاق (SAR/USD) غير مدعوم — سدّد بعملته نفسها." },
        { status: 409 },
      );
    }
    if (reason === "reversal_currency_mismatch") {
      return NextResponse.json(
        { message: "الردّ يجب أن يكون بعملة السند الأصلي نفسها — لا ردّ بعملة مختلفة." },
        { status: 409 },
      );
    }
    if (reason === "refund_snapshot_review_required") {
      return NextResponse.json(
        { reason, message: "تعذّر إثبات الردّ بما يحافظ على تسوية السند الأصلية. يلزم مراجعة المدير؛ لم يُسجّل أي ردّ جديد." },
        { status: 409 },
      );
    }
    if (reason === "reversal_exceeds_remaining") {
      return NextResponse.json(
        { message: "المبلغ يتجاوز المتبقي القابل للرد من السند الأصلي — مجموع الردود لا يتخطى مبلغ الأصل." },
        { status: 409 },
      );
    }
    if (reason === "idempotency_conflict") {
      return NextResponse.json(
        { message: "مفتاح الإعادة مستعمل بعملية مختلفة — مفتاح واحد لعملية واحدة." },
        { status: 409 },
      );
    }
    if (reason === "no_shift") {
      // بلا هذا الشرط تُسجَّل الدفعة خارج أي وردية فلا تظهر في جرد أحد — مالٌ دخل
      // ولا أثر له في أي إغلاق.
      return NextResponse.json(
        { message: "لا توجد وردية مفتوحة. افتح الوردية من شاشة المالية أولًا." },
        { status: 409 },
      );
    }
    // Creation/refund evidence is already committed atomically by recordPayment.
    // A replay trace is best-effort and must not turn a saved success into a failure.
    if (payment && replayed) {
      await recordAudit({
        action: "payment.idempotent_replay", entity: "payment",
        entityId: payment.id, entityLabel: payment.receiptNumber,
        details: { المريض: patientId, مفتاح_الإعادة: idempotencyKey },
        actor: session.username, actorRole: session.role,
      });
    }
    // replay = نفس العملية المالية التي نجحت قبل قليل، فيُعاد السند نفسه بلا 201.
    return NextResponse.json({ ...payment, idempotencyKey,
      ...(acknowledgmentEvidence ? { acknowledgmentEvidence } : {}) }, { status: replayed ? 200 : 201 });
  } catch (error) {
    if(error instanceof DebtRepaymentError)return NextResponse.json({message:error.message,code:error.code},{status:error.code==="unauthorized"?403:error.code==="invalid"?400:409});
    return NextResponse.json({ message: "تعذّر تسجيل الدفعة. أعد المحاولة." }, { status: 500 });
  }
}

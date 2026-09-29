import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { correctPayment, getSettings, type CorrectPaymentRefusal, type CorrectionTarget } from "@/lib/db";
import { CLINIC_BASE_CURRENCY, isCurrency, parseAmount } from "@/lib/money";
import { rateFromSettings } from "@/lib/settings";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (RC-1) تصحيح سند قبض أُدخل خطأً — للمدير، بسببٍ مكتوب.
 *
 * `mode: "void"` يعكس المتبقي من السند وحده (دفعةٌ سُجّلت ولم تقع). `mode: "correct"` يعكسه ويُصدر
 * السند الصحيح بدله في معاملةٍ واحدة. لا تعديل ولا حذف: السند الخطأ يبقى ظاهرًا معكوسًا بسببه.
 */
const MESSAGES: Record<CorrectPaymentRefusal, { status: number; message: string }> = {
  missing_reason: { status: 400, message: "اكتب سبب التصحيح (٣ أحرف على الأقل)." },
  not_found: { status: 404, message: "السند غير موجود." },
  not_a_receipt: { status: 409, message: "هذا سند ردّ — يُصحَّح سند القبض الأصلي لا ردُّه." },
  already_reversed: { status: 409, message: "هذا السند معكوسٌ بالكامل سلفًا — لا شيء يُصحَّح فيه." },
  no_shift: { status: 409, message: "لا توجد وردية مفتوحة. افتح الوردية من شاشة المالية أولًا — التصحيح يمرّ بالدرج." },
  invalid_invoice: { status: 409, message: "الفاتورة المختارة لا تخص المريض أو غير صالحة." },
  invalid_plan_target: { status: 409, message: "الخطة غير موجودة أو لا تخص المريض." },
  invalid_opening_target: { status: 409, message: "لا يوجد على المريض رصيد سابق بهذه العملة." },
  invalid_reversal: { status: 409, message: "تعذّر عكس السند الأصلي." },
  reversal_currency_mismatch: { status: 409, message: "العكس يكون بعملة السند الأصلي نفسها." },
  reversal_target_conflict: { status: 409, message: "العكس يسوّي حيث سُدِّد الأصل." },
  multiple_payment_targets: { status: 400, message: "هدفٌ واحد للسند الصحيح: فاتورة أو خطة أو رصيد سابق." },
  foreign_on_account_requires_target: { status: 400, message: "السند بعملة أجنبية يتطلب فاتورة أو خطة أو رصيدًا سابقًا بعملتها." },
  cross_currency_not_supported: { status: 409, message: "الدفع بعملةٍ مختلفة عن فاتورةٍ أو رصيدٍ بعملة اتفاق (SAR/USD) غير مدعوم — سدّد بعملته نفسها." },
  reversal_exceeds_remaining: { status: 409, message: "المتبقي من السند تغيّر أثناء التصحيح — أعد فتح السند وحاول مجددًا." },
  idempotency_conflict: { status: 409, message: "مفتاح الإعادة مستعمل بعملية مختلفة." },
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (session.role !== "admin") {
    return NextResponse.json({ message: "تصحيح سند القبض أو ردّه يتطلب صلاحية المدير." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const paymentId = Number(rawId);
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return NextResponse.json({ message: "رقم السند غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 300) : "";
  if (reason.length < 3) return NextResponse.json(MESSAGES.missing_reason, { status: 400 });
  const mode = source.mode === "void" ? "void" : "correct";
  /* مفتاح الإعادة للنمطين: يُحفظ على السند البديل، أو على سند العكس في الإبطال. */
  const idempotencyKeyRaw = request.headers.get("idempotency-key");
  const idempotencyKey = idempotencyKeyRaw && /^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKeyRaw.trim())
    ? idempotencyKeyRaw.trim() : null;

  let replacement: Parameters<typeof correctPayment>[0]["replacement"] = null;
  if (mode === "correct") {
    const currency = source.currency;
    if (!isCurrency(currency)) return NextResponse.json({ message: "اختر عملة السند الصحيح." }, { status: 400 });
    const amountMinor = parseAmount(String(source.amount ?? ""), currency);
    if (amountMinor === null || amountMinor <= 0) {
      return NextResponse.json({ message: "اكتب مبلغ السند الصحيح أكبر من صفر." }, { status: 400 });
    }
    const exchangeRate = rateFromSettings(await getSettings(), currency, CLINIC_BASE_CURRENCY);
    if (exchangeRate === null) {
      return NextResponse.json({ message: "سعر الصرف غير مضبوط. اضبطه في الإعدادات قبل قبض عملة أجنبية." }, { status: 409 });
    }
    let target: CorrectionTarget;
    if (source.target === "original") {
      target = { kind: "original" };
    } else {
      const invoiceIdRaw = Number(source.invoiceId);
      const planIdRaw = Number(source.planId);
      target = {
        kind: "explicit",
        invoiceId: Number.isInteger(invoiceIdRaw) && invoiceIdRaw > 0 ? invoiceIdRaw : null,
        planId: Number.isInteger(planIdRaw) && planIdRaw > 0 ? planIdRaw : null,
        openingCurrency: isCurrency(source.openingCurrency) ? source.openingCurrency : null,
      };
    }
    replacement = { amountMinor, currency, exchangeRate, method: source.method === "transfer" ? "transfer" : "cash", target };
  }

  try {
    // التدقيق يُكتب داخل معاملة التصحيح نفسها (لا تصحيح بلا أثره).
    const result = await correctPayment({
      paymentId, reason, actor: session.username, actorRole: session.role, idempotencyKey, replacement,
    });
    if (result.reason !== null) {
      const refusal = MESSAGES[result.reason];
      return NextResponse.json({ message: refusal.message }, { status: refusal.status });
    }
    return NextResponse.json(
      { reversal: result.reversal, replacement: result.replacement, replayed: result.replayed },
      { status: result.replayed ? 200 : 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر تصحيح السند. أعد المحاولة." }, { status: 500 });
  }
}

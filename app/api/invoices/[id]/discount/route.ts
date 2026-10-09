import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { applyAdminInvoiceDiscount, getInvoice } from "@/lib/db";
import { ADMIN_DISCOUNT_MESSAGE, ADMIN_DISCOUNT_REASON_MAX, ADMIN_DISCOUNT_REASON_MIN } from "@/lib/invoice-discount";
import { parseAmount } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (FIN-DISC) خصمٌ إداريٌّ على فاتورةٍ صادرة — للمدير وحده، بسببٍ مكتوب.
 *
 * الجسم: `{ amount, reason, expectedDiscountMinor, expectedSettledMinor }` — المبلغ الإضافي بعملة الفاتورة (نصًّا كما يُكتب في الشاشة)،
 * والخصم الذي رآه المدير عند فتح النموذج (ليُرفض الطلب إن تغيّر قبل الحفظ أو أُعيد إرساله).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (!isAdmin(session.role)) return NextResponse.json({ message: "الخصم على فاتورةٍ صادرة قرارٌ للمدير وحده." }, { status: 403 });
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ message: "رقم الفاتورة غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const reason = typeof source.reason === "string" ? source.reason.trim() : "";
  if (reason.length < ADMIN_DISCOUNT_REASON_MIN || reason.length > ADMIN_DISCOUNT_REASON_MAX) {
    return NextResponse.json({ message: ADMIN_DISCOUNT_MESSAGE.reason }, { status: 400 });
  }
  // Both what the manager saw must still hold: the discount and the explicit settlement on the invoice.
  const expectedDiscount = source.expectedDiscountMinor;
  const expectedSettled = source.expectedSettledMinor;
  if (!Number.isSafeInteger(expectedDiscount) || (expectedDiscount as number) < 0 || !Number.isSafeInteger(expectedSettled)) {
    return NextResponse.json({ message: ADMIN_DISCOUNT_MESSAGE.stale }, { status: 400 });
  }

  try {
    const invoice = await getInvoice(id);
    if (!invoice) return NextResponse.json({ message: ADMIN_DISCOUNT_MESSAGE.not_found }, { status: 404 });
    // The closed-period check runs inside the discount transaction, on the invoice's clinic date (review 5461906275).
    const amount = parseAmount(typeof source.amount === "string" ? source.amount : String(source.amount ?? ""), invoice.baseCurrency ?? "YER");
    if (amount === null || amount <= 0) return NextResponse.json({ message: ADMIN_DISCOUNT_MESSAGE.invalid_amount }, { status: 400 });
    const result = await applyAdminInvoiceDiscount({ invoiceId: id, additionalMinor: amount, expected: { discountMinor: expectedDiscount as number, settledMinor: expectedSettled as number },
      reason, actor: session.username, actorRole: session.role });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404
        : result.reason === "cancelled" || result.reason === "paid" || result.reason === "stale" || result.reason === "period_locked"
          || result.reason === "no_shift" || result.reason === "commission_paid" || result.reason === "commission_review" ? 409
          : result.reason === "failed" ? 500 : result.reason === "uncertain" ? 503 : 400;
      return NextResponse.json({ message: result.message }, { status });
    }
    // Committed. A failed read-back is still success: say so rather than invite a retry.
    return NextResponse.json({ invoice: result.invoice, remainingAfterMinor: result.remainingAfterMinor,
      ...(result.invoice === null ? { message: "سُجّل الخصم. أعد تحميل الفاتورة لعرض رصيدها." } : {}) },
    { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Only reachable before the discount transaction committed (it reports its own outcome otherwise).
    return NextResponse.json({ message: ADMIN_DISCOUNT_MESSAGE.failed }, { status: 500 });
  }
}

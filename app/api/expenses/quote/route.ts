import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettings, ratesFromSettings, recordExpense } from "@/lib/db";
import { parseExpenseRequest, refusalStatus } from "@/lib/expense-request";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { refusalMessage } from "@/lib/supplier-payments";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (P0-2) معاينة سند الصرف قبل تأكيده — الحساب نفسه الذي يُسجِّل (recordExpense
 * بـquoteOnly) بلا أي كتابة: سعر الصرف المستعمل، والمكافئ الذي سيُخصم من الفاتورة،
 * والمتبقي بعده، ورصيد الجهة. فما يراه المستخدم هو ما سيُحفظ حرفيًّا.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role) || (session.role === "cashier" && !session.financeAccess?.createExpenses)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const settingsRates = ratesFromSettings(await getSettings());
  const parsed = parseExpenseRequest((body ?? {}) as Record<string, unknown>, settingsRates, isAdmin(session.role));
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: parsed.status });
  const value = parsed.value;
  try {
    const { reason, quote } = await recordExpense({
      category: value.category, partyId: value.partyId, payeeText: value.payeeText,
      amountMinor: value.amountMinor, currency: value.currency, baseCurrency: CLINIC_BASE_CURRENCY,
      exchangeRate: value.exchangeRate, payableId: value.payableId, note: value.note,
      createdBy: session.username, rates: settingsRates,
      payableExchangeRate: value.payableExchangeRate,
      rateOverrideReason: value.rateOverrideReason,
      prepaymentReason: value.prepaymentReason,
      quoteOnly: true,
    });
    return NextResponse.json({
      ok: reason === null,
      code: reason,
      message: reason ? refusalMessage(reason, quote) : null,
      status: reason ? refusalStatus(reason) : 200,
      quote,
      settingsRates,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر حساب المعاينة. أعد المحاولة." }, { status: 500 });
  }
}

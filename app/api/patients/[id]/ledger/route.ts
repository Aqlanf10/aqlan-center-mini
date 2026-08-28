import { NextResponse } from "next/server";
import { asPaymentLikes, getSettings, patientLedger } from "@/lib/db";
import { isCurrency, patientBalance } from "@/lib/money";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** حساب المريض: فواتيره ودفعاته ورصيده — الرقم الذي يُسأل عنه على الباب. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }

  try {
    const [{ invoices, payments, opening }, settings] = await Promise.all([
      patientLedger(id),
      getSettings(),
    ]);
    const base = settings["finance.base_currency"];
    if (!isCurrency(base)) {
      return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
    }
    const balance = patientBalance(
      invoices.map((invoice) => ({
        totalMinor: invoice.totalMinor,
        discountMinor: invoice.discountMinor,
        status: invoice.status,
      })),
      asPaymentLikes(payments),
      opening?.amountMinor ?? 0,
    );
    return NextResponse.json({ invoices, payments, opening, balance, baseCurrency: base });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل حساب المريض." }, { status: 500 });
  }
}

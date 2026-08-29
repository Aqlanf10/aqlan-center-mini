import { NextResponse } from "next/server";
import { asPaymentLikes, getSettings, patientLedger } from "@/lib/db";
import { isCurrency, patientBalance } from "@/lib/money";
import { requirePortalSession } from "@/lib/portal-server";

export const dynamic = "force-dynamic";

/**
 * كشف حساب المريض في البوابة.
 *
 * لا معرّف مريض من العميل — المعرّف من الجلسة الموقّعة وحدها. والحساب يُقرأ من
 * `patientLedger()` نفسها التي تخدم شاشة الحساب الداخلية، وبنفس خريطة الحساب
 * في `patientBalance` حرفيًا: نفس الفواتير، نفس الدفعات، نفس الافتتاحي. لو ظهر
 * رقم مختلف هنا فالخلل في البوابة لا في المصدر.
 */
export async function GET() {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  try {
    const [{ invoices, payments, opening }, settings] = await Promise.all([
      patientLedger(session.patientId),
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
    return NextResponse.json({ message: "تعذّر تحميل كشف الحساب." }, { status: 500 });
  }
}

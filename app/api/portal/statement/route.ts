import { NextResponse } from "next/server";
import { openingMinorsOf, patientLedger, patientPlanCurrencies } from "@/lib/db";
import { patientBalancesByCurrency, toCurrencyPaymentLikes } from "@/lib/money";
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
    const [{ invoices, payments, openings }, planCurrencies] = await Promise.all([
      patientLedger(session.patientId),
      patientPlanCurrencies(session.patientId),
    ]);
    /* (TD-05) بوابة المريض ترى ما يراه الصندوق: أرصدةً بعملاتها المستقلة —
       ودفعات الخطط (المقدَّمة قبل الفوترة) تسوّي دلو عملة خططها. */
    const balances = patientBalancesByCurrency(
      invoices.map((invoice) => ({
        totalMinor: invoice.totalMinor,
        discountMinor: invoice.discountMinor,
        status: invoice.status,
        baseCurrency: invoice.baseCurrency,
      })),
      toCurrencyPaymentLikes(
        session.patientId,
        payments.map((payment) => ({
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          exchangeRate: payment.exchangeRate,
          baseAmountMinor: payment.baseAmountMinor,
          kind: payment.kind,
          invoiceId: payment.invoiceId,
          planId: payment.planId,
          openingCurrency: payment.openingCurrency,
        })),
        // (المراجعة النهائية للمال ٢) المرجع يحمل مالكه — ومستندات هذا الكشف من
        // المريض نفسه فالملكية تُطابَق حكمًا وتُمنح صريحةً للمسار القانوني.
        new Map(invoices.map((invoice) => [invoice.id, { patientId: session.patientId, currency: invoice.baseCurrency }])),
        planCurrencies,
      ),
      openingMinorsOf(openings),
    );
    return NextResponse.json({
      invoices, payments, opening: openings.find((row) => row.currency === "YER") ?? null, openings,
      balance: balances.YER, balances, baseCurrency: "YER",
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل كشف الحساب." }, { status: 500 });
  }
}

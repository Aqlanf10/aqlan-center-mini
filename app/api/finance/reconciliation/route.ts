import { NextRequest, NextResponse } from "next/server";
import { getOpenShift, listShifts, listShiftPayments, listShiftExpenses, getSettings } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { CURRENCIES, isCurrency, type Currency } from "@/lib/money";

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "غير مصرح." }, { status: 401 });
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "المطابقة المالية للإدارة والاستقبال المصرح لهما فقط." }, { status: 403 });
  }

  try {
    const settings = await getSettings();
    const baseCurrency: Currency = isCurrency(settings["finance.base_currency"])
      ? settings["finance.base_currency"]
      : "YER";

    const openShift = await getOpenShift();
    let currentShiftSummary = null;

    if (openShift) {
      const [payments, expenses] = await Promise.all([
        listShiftPayments(openShift.id),
        listShiftExpenses(openShift.id),
      ]);

      const income: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
      const refunds: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
      const paidExpenses: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
      const expected: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };

      for (const p of payments) {
        if (p.kind === "refund") {
          refunds[p.currency] = (refunds[p.currency] || 0) + p.amountMinor;
        } else {
          income[p.currency] = (income[p.currency] || 0) + p.amountMinor;
        }
      }

      for (const e of expenses) {
        paidExpenses[e.currency] = (paidExpenses[e.currency] || 0) + e.amountMinor;
      }

      for (const cur of CURRENCIES) {
        expected[cur] =
          (openShift.opening[cur] || 0) +
          (income[cur] || 0) -
          (refunds[cur] || 0) -
          (paidExpenses[cur] || 0);
      }

      currentShiftSummary = {
        shift: openShift,
        paymentsCount: payments.length,
        expensesCount: expenses.length,
        income,
        refunds,
        expenses: paidExpenses,
        expected,
      };
    }

    const pastShifts = await listShifts(30);

    return NextResponse.json({
      baseCurrency,
      openShift: currentShiftSummary,
      shifts: pastShifts,
    });
  } catch (error) {
    console.error("Reconciliation error:", error);
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "فشل جلب بيانات المطابقة." },
      { status: 500 },
    );
  }
}

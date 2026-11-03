import { NextRequest, NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getOpenShift, listShifts, listShiftPayments, listShiftExpenses, shiftDrawerBreakdown } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canViewMoney } from "@/lib/roles";
import { type Currency, CLINIC_BASE_CURRENCY } from "@/lib/money";
import { NO_STORE } from "@/lib/canonical-patient-http";
import { reconciliationGetCanonicalResponse } from "@/lib/canonical-clinic-finance";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";

export async function GET(req: NextRequest) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") return reconciliationGetCanonicalResponse(selected.handle);
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "غير مصرح." }, { status: 401 });
  if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "المطابقة المالية للإدارة والاستقبال المصرح لهما فقط." }, { status: 403 });
  }

  try {
    // (TD-05) الأساس دستوري من الكود.
    const baseCurrency: Currency = CLINIC_BASE_CURRENCY;

    const openShift = await getOpenShift();
    let currentShiftSummary = null;

    if (openShift) {
      const [payments, expenses, drawer] = await Promise.all([
        listShiftPayments(openShift.id),
        listShiftExpenses(openShift.id),
        shiftDrawerBreakdown(openShift),
      ]);
      /* (P1-3) القاعدة الواحدة (lib/shift-close.ts): المتوقَّع في الدرج نقدٌ فقط؛
         التحويل يُعرض منفصلًا (nonCashIn) ولا يُحسب في الدرج. */
      currentShiftSummary = {
        shift: openShift,
        paymentsCount: payments.length,
        expensesCount: expenses.length,
        income: drawer.cashIn,
        refunds: drawer.cashRefunds,
        nonCashIn: drawer.nonCashIn,
        nonCashRefunds: drawer.nonCashRefunds,
        expenses: drawer.spent,
        expected: drawer.expected,
      };
    }

    const pastShifts = await listShifts(30);

    return NextResponse.json({
      clinicTimeZone: CLINIC_TIME_ZONE,
      baseCurrency,
      openShift: currentShiftSummary,
      shifts: pastShifts,
    });
  } catch (error) {
    console.error("Reconciliation error:", error);
    // لا تُكشف تفاصيل الاستثناء للمستخدم (CLAUDE.md).
    return NextResponse.json({ message: "فشل جلب بيانات المطابقة." }, { status: 500 });
  }
}

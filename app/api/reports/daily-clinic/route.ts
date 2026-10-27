import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { getDailyClinicReportToday, loadDailyClinicReport } from "@/lib/daily-clinic-report";
import { DailyClinicReportIntegrityError, isDailyClinicReportDate } from "@/lib/daily-clinic-report-model";

import { DailyClinicExpenseIntegrityError } from "@/lib/daily-clinic-expense-report";
import { FinancialCurrencyIntegrityError } from "@/lib/money";
import { ReclassificationProofError } from "@/lib/invoice-currency-reclassification";

// Only literals from this whitelist may reach server logs. Never forward an
// exception's message/name/stack, SQL, request parameters or financial evidence.
function diagnosticCode(error: unknown): string {
  if (error instanceof DailyClinicReportIntegrityError) {
    switch (error.message) {
      case "Invoice line plan currency conflict": return "INVOICE_LINE_PLAN_CURRENCY";
      case "Invoice/plan currency conflict": return "INVOICE_PLAN_CURRENCY";
      case "Unresolved or cross-patient agreement link": return "AGREEMENT_OWNERSHIP";
      case "Cross-patient invoice line source": return "INVOICE_LINE_OWNERSHIP";
      case "Historical document line count conflict": return "HISTORICAL_DOCUMENT_LINES";
      case "Historical document clinical ownership conflict": return "HISTORICAL_DOCUMENT_OWNERSHIP";
      default: return "REPORT_INTEGRITY";
    }
  }
  if (error instanceof DailyClinicExpenseIntegrityError) return "EXPENSE_INTEGRITY";
  if (error instanceof FinancialCurrencyIntegrityError) return "FINANCIAL_CURRENCY_INTEGRITY";
  if (error instanceof ReclassificationProofError) return "RECLASSIFICATION_PROOF";
  return "UNEXPECTED_FAILURE";
}

export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Vary": "Cookie, Authorization",
};

/** This combines clinical and financial details. Broader financial privileges
 * do not grant access: authorize the current authenticated admin first. */
export async function GET(request: Request) {
  try {
    const session = await requireSession();
    if (!session) {
      return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers });
    }
    if (session.role !== "admin") {
      return NextResponse.json({ message: "كشف إقفال اليوم متاح للمدير فقط." }, { status: 403, headers });
    }
    const dates = new URL(request.url).searchParams.getAll("date");
    const date = dates.length === 0 ? getDailyClinicReportToday() : dates[0];
    if (dates.length > 1 || !isDailyClinicReportDate(date)) {
      return NextResponse.json({ message: "اختر تاريخًا صحيحًا بصيغة YYYY-MM-DD." }, { status: 400, headers });
    }
    return NextResponse.json(await loadDailyClinicReport(date), { headers });
  } catch (error) {
    console.error("[daily-clinic-report]", diagnosticCode(error));
    // Integrity diagnostics can contain patient/financial evidence. Never
    // serialize an exception, SQL or partial financial report to the browser.
    return NextResponse.json({ message: "تعذّر إعداد كشف إقفال اليوم. أعد المحاولة." }, { status: 500, headers });
  }
}

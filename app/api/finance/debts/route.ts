import { NextResponse } from "next/server";
import { getSettings, patientDebtReport } from "@/lib/db";
import { isCurrency } from "@/lib/money";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "المديونية للإدارة والاستقبال." }, { status: 403 });
  }

  try {
    const [rows, settings] = await Promise.all([patientDebtReport(), getSettings()]);
    const base = settings["finance.base_currency"];
    return NextResponse.json({ rows, baseCurrency: isCurrency(base) ? base : "YER" });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المديونية." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, commissionReport, getSettings } from "@/lib/db";
import { isCurrency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تقرير العمولات للمدير وحده." }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : monthStart;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  const [start, end] = from <= to ? [from, to] : [to, from];

  try {
    const [rows, settings] = await Promise.all([commissionReport(start, end), getSettings()]);
    const base = settings["finance.base_currency"];
    return NextResponse.json({ from: start, to: end, rows, baseCurrency: isCurrency(base) ? base : "YER" });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل العمولات." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, commissionReport, findUserByUsername, getSettings } from "@/lib/db";
import { isCurrency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { isAdmin } from "@/lib/roles";
import { canDoctorViewClinicRevenue } from "@/lib/doctor-permissions";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  /* صلاحيات الوكيل المساعد + «المالية المخفية»: الطبيب يرى مستحقاته الشخصية
     فقط (canViewOwnCommissions) — ورؤية عمولات الجميع تحتاج منحًا صريحًا.
     الإدارة كما كانت، والاستقبال خارج الباب تمامًا. الربط بجهة الطبيب عبر
     party_id (V2 §٣٥). */
  let doctorPartyId: number | null = null;
  let isPersonalOnly = false;

  if (!isAdmin(session.role)) {
    if (session.role === "doctor") {
      const user = await findUserByUsername(session.username).catch(() => null);
      if (!user?.permissions?.canViewOwnCommissions) {
        return NextResponse.json({ message: "غير مصرح لك بالاطلاع على العمولات والمستحقات." }, { status: 403 });
      }
      const canViewAll =
        canDoctorViewClinicRevenue(user.permissions, session.role) ||
        Boolean(user.permissions?.canViewOtherDoctorsAccounts);
      if (!canViewAll) {
        doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
        isPersonalOnly = true;
      }
    } else {
      return NextResponse.json({ message: "تقرير العمولات للمدير أو الطبيب المصرح له." }, { status: 403 });
    }
  }

  const params = new URL(request.url).searchParams;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = DATE_PATTERN.test(params.get("from") ?? "") ? params.get("from")! : monthStart;
  const to = DATE_PATTERN.test(params.get("to") ?? "") ? params.get("to")! : today;
  const [start, end] = from <= to ? [from, to] : [to, from];

  try {
    const [allRows, settings] = await Promise.all([commissionReport(start, end), getSettings()]);
    const base = settings["finance.base_currency"];

    const rows = doctorPartyId
      ? allRows.filter((r) => r.doctorId === doctorPartyId)
      : allRows;

    return NextResponse.json({
      from: start,
      to: end,
      rows,
      baseCurrency: isCurrency(base) ? base : "YER",
      isPersonalOnly,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل العمولات." }, { status: 500 });
  }
}

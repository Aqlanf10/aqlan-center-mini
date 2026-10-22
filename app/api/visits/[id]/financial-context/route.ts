import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { canViewMoney } from "@/lib/roles";
import { getClinicalVisit, CLINIC_TIME_ZONE } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { getVisitFinancialContext } from "@/lib/visit-financial-context-db";
import { redactVisitFinancialContext } from "@/lib/visit-financial-context";

export const dynamic = "force-dynamic";
/** Same patient/date gates as clinical GET; this read grants no command permissions. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة." }, { status: 401 });
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  try {
    const visit = await getClinicalVisit(id, { actorPartyId: session.partyId ?? null });
    if (!visit) return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    if (visit.patientId !== null && !await canAccessPatient(session, visit.patientId)) {
      return NextResponse.json({ message: "هذه زيارة مريضٍ ليس من مرضاك." }, { status: 403 });
    }
    if (session.role === "assistant" && clinicDateString(new Date(visit.arrivedAt), CLINIC_TIME_ZONE) !== clinicDateString(new Date(), CLINIC_TIME_ZONE)) {
      return NextResponse.json({ message: "المساعد السريري يعمل على زيارات اليوم وحدها." }, { status: 403 });
    }
    const result = await getVisitFinancialContext(id, visit.patientId);
    if (!result) return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    return NextResponse.json(redactVisitFinancialContext(result, canViewMoney(session.role)), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json({ message: "تعذّر التحقق من مصادر العمل." }, { status: 500 });
  }
}

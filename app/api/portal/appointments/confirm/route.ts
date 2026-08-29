import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, portalConfirmAttendance, recordAudit } from "@/lib/db";
import { requirePortalSession } from "@/lib/portal-server";
import { clinicDateString } from "@/lib/schedule";

export const dynamic = "force-dynamic";

const CONFIRM_REASON_TEXT: Record<string, string> = {
  not_found: "الموعد غير موجود في ملفك.",
  not_booked: "لا يمكن تأكيد موعد غير مؤكد القيد.",
  past: "الموعد ماضٍ — تأكيد الحضور قبل موعده لا بعده.",
  too_far: "التأكيد متاح خلال الثلاثين يومًا السابقة للموعد.",
};

/**
 * تأكيد حضور موعد.
 *
 * معرّف المريض من الجلسة لا من الجسم: لا يمكن لمريض أن يؤكد موعد غيره ولو
 * خمّن معرّفات. والفعل يُدقَّق — من أي حساب جلسة قدم التأكيد ومتى.
 */
export async function POST(request: Request) {
  const session = await requirePortalSession();
  if (!session) {
    return NextResponse.json({ message: "سجّل الدخول إلى البوابة." }, { status: 401 });
  }
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const id = Number((body as Record<string, unknown>)?.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "معرّف الموعد غير صالح." }, { status: 400 });
  }

  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const result = await portalConfirmAttendance(id, session.patientId, today);
    if (!result.ok) {
      return NextResponse.json({ message: CONFIRM_REASON_TEXT[result.reason] ?? "تعذّر التأكيد." }, { status: 409 });
    }
    await recordAudit({
      action: "portal.confirm",
      entity: "appointment",
      entityId: id,
      details: { patientNumber: session.patientNumber },
      actor: `مريض: ${session.fullName}`,
    });
    return NextResponse.json({ confirmedAt: result.confirmedAt });
  } catch {
    return NextResponse.json({ message: "تعذّر تأكيد الحضور الآن." }, { status: 500 });
  }
}

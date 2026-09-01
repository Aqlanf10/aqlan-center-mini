import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, doctorOwnsPatient, getSettings, patientWorkflow } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/**
 * ملخص رحلة المريض — الاستعلام الوحيد الذي يحتاجه رأس ملف المريض.
 *
 * يجيب عن سؤالين: «ما وضع هذا المريض؟» و«ما المطلوب مني الآن؟» — من دون تحميل
 * الأشعة والسيفالو والمعمل والمواد بكامل تفاصيلها في أول فتح (المواصفة §٤٨:
 * Summary APIs ثم Lazy Load).
 *
 * والمال هنا يُفحص في الخادم: من لا يملك رؤيته (الطبيب افتراضيًا) يصله الملخص
 * بلا أرصدة — إخفاء الزر في الشاشة ليس منعًا (المواصفة §٣٦).
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const patientId = await idFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم ملف غير صالح." }, { status: 400 });

  // عزل الطبيب (§٣٩): مرضاه فقط — الفحص في الخادم قبل أي استعلام مالي.
  if (session.role === "doctor" && typeof session.partyId === "number" && session.partyId) {
    const owns = await doctorOwnsPatient(session.partyId, patientId).catch(() => false);
    if (!owns) {
      return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
    }
  }

  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const summary = await patientWorkflow(patientId, today);
    if (!summary.patient) {
      return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    }

    const settings = await getSettings();
    const doctorSeesMoney =
      session.role === "doctor" && settings["workflow.doctor_financial_view"] === "true";
    const maySeeFinancial = canHandleMoney(session.role) || doctorSeesMoney;

    return NextResponse.json({
      ...summary,
      today,
      financial: maySeeFinancial ? summary.financial : null,
      canSeeFinancial: maySeeFinancial,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل ملخص المريض." }, { status: 500 });
  }
}

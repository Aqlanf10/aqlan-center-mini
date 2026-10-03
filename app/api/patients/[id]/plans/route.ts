import { NextResponse } from "next/server";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import {
  CLINIC_TIME_ZONE,
  getSettings,
  findUserByUsername,
  doctorOwnsPatient,
  listPatientPlans,
  listPatientPlannedVisitReads,
} from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { canReadPatientPlanFinance, patientPlanCapabilities, projectPatientPlan } from "@/lib/patient-plan-projection";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { resolveAppointmentReadScope } from "@/lib/appointment-read-access";
import { patientAppointmentVisibility } from "@/lib/appointment-read-scope";

export const dynamic = "force-dynamic";

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

/**
 * خطط علاج المريض كما يحتاجها ملفه — لكل الأدوار.
 *
 * كان المسار الوحيد للخطط `/api/plans` محجوزًا لصاحبي المال، فلا يرى الطبيب خطة
 * مريضه وهو الذي يكتبها وينفّذها — وملف المريض كان يطلب هذا المسار فيصمت (٤٠٤)
 * وتبقى بطاقة «الخطة النشطة» فارغة إلى الأبد. هذا المسار يصلحهما معًا:
 *
 * - الطبيب يرى البنود والجلسات والزيارات المخطَّطة وقصة العمل (أُنجز/بقي) —
 *   وكلٌّ ما هو مالي (أقساط، مدفوع، متأخر) يُسلب في الخادم إلا بإذن.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const patientId = await idFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم ملف غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, patientId, "canViewPlans"))) {
    return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على خطط هذا المريض." }, { status: 403 });
  }

  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const settings = await getSettings();
    // (TD-05) الأساس دستوري من الكود — والإعدادات لصلاحية رؤية الطبيب للمالية.
    const base = CLINIC_BASE_CURRENCY;
    const user = session.role === "doctor" ? await findUserByUsername(session.username) : null;
    const maySeeFinancial = canReadPatientPlanFinance(session.role,
      settings["workflow.doctor_financial_view"] === "true",
      session.role === "doctor" && await canAccessPatient(session, patientId, "canViewPatientPayments"));
    const ownsPatient = session.role === "doctor" && Boolean(user?.isActive && user.partyId)
      ? await doctorOwnsPatient(user!.partyId!, patientId).catch(() => false) : false;
    const capabilities = patientPlanCapabilities(session.role, user?.permissions ?? null, ownsPatient);

    const appointmentScope = await resolveAppointmentReadScope(session, [patientId]);
    const [plans, plannedVisits] = await Promise.all([
      listPatientPlans(patientId, today),
      listPatientPlannedVisitReads(patientId, appointmentScope),
    ]);

    const visiblePlans = plans.map((plan) => projectPatientPlan(plan, maySeeFinancial));

    return NextResponse.json({
      plans: visiblePlans,
      plannedVisits,
      appointmentVisibility: patientAppointmentVisibility(appointmentScope, patientId),
      today,
      baseCurrency: base === "SAR" || base === "USD" || base === "YER" ? base : "YER",
      canSeeFinancial: maySeeFinancial,
      capabilities,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل خطط المريض." }, { status: 500 });
  }
}

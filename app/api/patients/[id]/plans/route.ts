import { NextResponse } from "next/server";
import {
  CLINIC_TIME_ZONE,
  getSettings,
  listPatientPlans,
  listPatientPlannedVisits,
} from "@/lib/db";
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

  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const settings = await getSettings();
    const base = settings["finance.base_currency"];
    const doctorSeesMoney =
      session.role === "doctor" && settings["workflow.doctor_financial_view"] === "true";
    const maySeeFinancial = canHandleMoney(session.role) || doctorSeesMoney;

    const [plans, plannedVisits] = await Promise.all([
      listPatientPlans(patientId, today),
      listPatientPlannedVisits(patientId),
    ]);

    const visiblePlans = maySeeFinancial
      ? plans
      : plans.map((plan) => ({
          ...plan,
          installments: [],
          paidMinor: 0,
          progress: {
            ...plan.progress,
            paidMinor: 0, remainingMinor: 0, overdueMinor: 0,
            nextDueAmountMinor: 0, paidCount: 0,
          },
        }));

    return NextResponse.json({
      plans: visiblePlans,
      plannedVisits,
      today,
      baseCurrency: base === "SAR" || base === "USD" || base === "YER" ? base : "YER",
      canSeeFinancial: maySeeFinancial,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل خطط المريض." }, { status: 500 });
  }
}

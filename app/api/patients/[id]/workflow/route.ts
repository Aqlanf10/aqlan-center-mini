import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, getSettings, patientWorkflow } from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { canViewPlanItems } from "@/lib/case-route";
import { resolveAppointmentReadScope } from "@/lib/appointment-read-access";
import { patientAppointmentVisibility } from "@/lib/appointment-read-scope";
import { workflowCalendar, workflowCalendarAlertVisible } from "@/lib/patient-workflow-calendar";
import { workflowDocuments } from "@/lib/patient-workflow-documents";

export const dynamic = "force-dynamic";

// Generated clinical context from patientWorkflow; unknown future alert kinds
// must not expose a new financial channel to readers without money access.
const CLINICAL_ALERT_KINDS = new Set([
  "unscheduled_visit", "lab_open", "plan_ready", "plan_blocked", "case_waiting",
  "referral_blocker", "referral_returned", "active_problems",
]);
const NON_PLAN_ALERT_KINDS = new Set([
  "lab_open", "case_waiting", "referral_blocker", "referral_returned", "active_problems",
]);

function withoutPlanAmounts(row: { balanceMinor: number; invoicedMinor: number; paidMinor: number; openingMinor: number }) {
  return {
    balanceMinor: row.balanceMinor, invoicedMinor: row.invoicedMinor,
    paidMinor: row.paidMinor, openingMinor: row.openingMinor,
    agreedMinor: null, treatmentDoneMinor: null, remainingTreatmentMinor: null,
    agreementPaidMinor: null, agreementRemainingMinor: null,
  };
}

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
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }

  try {
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const appointmentScope = await resolveAppointmentReadScope(session, [patientId]);
    const summary = await patientWorkflow(patientId, today, appointmentScope);
    if (!summary.patient) {
      return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    }

    const calendar = workflowCalendar({ ...summary,
      appointmentVisibility: patientAppointmentVisibility(appointmentScope, patientId),
    });
    const planVisible = await canViewPlanItems(session, patientId);
    // Count/existence metadata follows the same current read gate as document GET.
    const documents = workflowDocuments({ counts: summary.counts,
      documentsVisible: await canAccessPatient(session, patientId, "canViewXrays") });
    const counts = { visits: summary.counts.visits, openLabOrders: summary.counts.openLabOrders,
      documents: documents.documents, orthoCase: summary.counts.orthoCase };
    const settings = await getSettings();
    const doctorSeesMoney = session.role === "doctor"
      && settings["workflow.doctor_financial_view"] === "true"
      && await canAccessPatient(session, patientId, "canViewPatientPayments");
    const maySeeFinancial = canHandleMoney(session.role) || doctorSeesMoney;
    const alerts = summary.alerts.filter((alert) =>
      (maySeeFinancial || CLINICAL_ALERT_KINDS.has(alert.kind))
      && (planVisible || NON_PLAN_ALERT_KINDS.has(alert.kind))
      && workflowCalendarAlertVisible(alert.kind, calendar.appointmentVisibility));
    // Hidden values are unknown, never a zero balance. Explicitly project the
    // clinical fields so adding a financial field upstream cannot bypass this gate.
    const activePlans = !planVisible ? [] : maySeeFinancial ? summary.activePlans : summary.activePlans.map((plan) => ({
      id: plan.id,
      title: plan.title,
      specialty: plan.specialty,
      primaryDoctorName: plan.primaryDoctorName,
      consentAt: plan.consentAt,
      itemsCount: plan.itemsCount,
      doneItems: plan.doneItems,
      totalMinor: null,
      doneMinor: null,
      remainingMinor: null,
      overdueMinor: null,
      nextDueDate: null,
      financialVisible: false,
    }));
    const openVisit = summary.openVisit && !planVisible ? { ...summary.openVisit, plannedTitle: null } : summary.openVisit;
    const financial = !maySeeFinancial ? null : planVisible || !summary.financial ? summary.financial : {
      ...withoutPlanAmounts(summary.financial),
      ...(summary.financial.byCurrency ? {
        byCurrency: Object.fromEntries(Object.entries(summary.financial.byCurrency)
          .map(([currency, row]) => [currency, withoutPlanAmounts(row)])),
      } : {}),
    };

    /* (P0-F) المساعد السريري: رأس الملف بلا خطط ولا أسعار ولا مواعيد ولا زيارات مخطّطة —
       يرى المريض وتنبيهاته وزيارته الجارية فقط. */
    if (session.role === "assistant") {
      return NextResponse.json({
        patient: summary.patient, lastVisit: summary.lastVisit, counts, documentsVisible: documents.documentsVisible,
        today,
        planVisible: false,
        openVisit,
        nextAppointment: null,
        appointmentVisibility: "hidden",
        plannedVisits: [],
        activePlans: [],
        financial: null,
        canSeeFinancial: false,
        alerts,
      });
    }

    return NextResponse.json({
      patient: summary.patient, lastVisit: summary.lastVisit, counts, documentsVisible: documents.documentsVisible,
      nextAppointment: calendar.nextAppointment,
      appointmentVisibility: calendar.appointmentVisibility,
      today,
      planVisible,
      openVisit,
      activePlans,
      plannedVisits: planVisible ? calendar.plannedVisits : [],
      alerts,
      financial,
      canSeeFinancial: maySeeFinancial,
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل ملخص المريض." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { CLINIC_TIME_ZONE, createPlan, createPlanV2, doctorOwnsPatient, findUserByUsername, getSettings, listActivePlans, listPatientPlans, listServices, recordAudit } from "@/lib/db";
import { CLINIC_BASE_CURRENCY } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { canHandleMoney, canViewMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { canReadPatientPlanFinance, projectPatientPlan } from "@/lib/patient-plan-projection";
import { canAccessPatient } from "@/lib/patient-access";
import { isRestrictedRole } from "@/lib/role-routes";
import { resolvePlanCreatePreparation } from "@/lib/plan-create-preparation";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const patientId = Number(new URL(request.url).searchParams.get("patientId"));

  /* صلاحيات الوكيل المساعد: الطبيب بلا صلاحية الخطط ممنوع، ومن يملكها لا يقرأ
     إلا خطط مرضاه (عزل الخادم) — وعموم الخطط تبقى للإدارة والاستقبال. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!user?.isActive || user.permissions?.canViewPlans !== true) {
      return NextResponse.json({ message: "غير مصرّح لك بعرض خطط العلاج." }, { status: 403 });
    }
    if (Number.isInteger(patientId) && patientId > 0) {
      const doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
      if (doctorPartyId) {
        const owns = await doctorOwnsPatient(doctorPartyId, patientId).catch(() => false);
        if (!owns) {
          return NextResponse.json(
            { message: "غير مصرّح لك بالاطلاع على خطط هذا المريض." },
            { status: 403 },
          );
        }
      } else {
        return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
      }
    } else {
      return NextResponse.json({ message: "حدّد المريض أولًا — القائمة الشاملة للإدارة والاستقبال." }, { status: 403 });
    }
  } else if (!canViewMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  try {
    const settings = session.role === "doctor" ? await getSettings() : null;
    const maySeeFinancial = canReadPatientPlanFinance(session.role,
      settings?.["workflow.doctor_financial_view"] === "true",
      session.role === "doctor" && await canAccessPatient(session, patientId, "canViewPatientPayments"));
    const plans = Number.isInteger(patientId) && patientId > 0
      ? await listPatientPlans(patientId, today)
      : await listActivePlans(today);
    // Finance roles need receivables and installments, not treatment items,
    // tooth codes, clinical notes or patient consent details.
    const result = isRestrictedRole(session.role) ? plans.map((plan) => ({
      id: plan.id,
      patientId: plan.patientId,
      patientName: plan.patientName,
      patientPhone: plan.patientPhone,
      title: `خطة مالية #${plan.id}`,
      totalMinor: plan.totalMinor,
      baseCurrency: plan.baseCurrency,
      status: plan.status,
      lastReminderAt: plan.lastReminderAt,
      installments: plan.installments,
      paidMinor: plan.paidMinor,
      progress: plan.progress,
    })) : plans.map((plan) => projectPatientPlan(plan, maySeeFinancial));
    return NextResponse.json({ plans: result, today, baseCurrency: CLINIC_BASE_CURRENCY });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الخطط." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patientId = Number(source.patientId);
  /* صلاحيات الوكيل المساعد: الطبيب الذي فتح له المدير تحرير الخطط ينشئها
     لمرضاه فقط؛ وما عدا ذلك يبقى باب الخطة للإدارة والاستقبال كما في V2. */
  if (session.role === "doctor") {
    const user = await findUserByUsername(session.username).catch(() => null);
    if (user?.permissions && user.permissions.canEditPlans === false) {
      return NextResponse.json({ message: "غير مصرّح لك بإنشاء أو تعديل خطط العلاج." }, { status: 403 });
    }
    const doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
    if (!doctorPartyId || !Number.isInteger(patientId) || !(await doctorOwnsPatient(doctorPartyId, patientId).catch(() => false))) {
      return NextResponse.json(
        { message: "غير مصرّح لك بإنشاء خطة لهذا المريض." },
        { status: 403 },
      );
    }
  } else if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });
  }

  const prepared = await resolvePlanCreatePreparation(source, patientId, session, {
    getSettings,
    listServices,
    clinicDate: () => clinicDateString(new Date(), CLINIC_TIME_ZONE),
  });
  if (!prepared.ok) return NextResponse.json(prepared.body, { status: prepared.status });

  const plan = prepared.plan;
  try {
    if (plan.writer === "legacy") {
      const id = await createPlan(plan.input);
      return NextResponse.json({ id }, { status: 201 });
    }
    const created = await createPlanV2(plan.input);
    if (!created.ok) return NextResponse.json({ message: created.message }, { status: 400 });
    await recordAudit({ ...plan.audit, entityId: created.planId });
    return NextResponse.json({ id: created.planId }, { status: 201 });
  } catch {
    return NextResponse.json({ message: plan.failureMessage }, { status: 500 });
  }
}

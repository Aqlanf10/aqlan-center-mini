import { NextResponse } from "next/server";
import { patientLegacyOnboarding } from "@/lib/legacy-onboarding-db";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
import { doctorOwnsPatient, findUserByUsername } from "@/lib/db";

export const dynamic = "force-dynamic";

/** (P1-A) قائمة تهيئة مريض التقويم السابق — قراءةٌ فقط، بلا مبالغ. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  const patientId = Number((await context.params).id);
  const requestedCase = new URL(request.url).searchParams.get("caseId");
  const caseId = requestedCase === null ? undefined : Number(requestedCase);
  if (!Number.isSafeInteger(patientId) || patientId <= 0
    || caseId !== undefined && (!Number.isSafeInteger(caseId) || caseId <= 0)) {
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }
  try {
    const onboarding = await patientLegacyOnboarding(patientId, caseId);
    // Clinical classification remains visible through the existing patient gate.
    // New plan/item/document identities require the existing plan-read capability.
    let canReadSources = session.role === "admin" || session.role === "reception";
    if (session.role === "doctor") {
      // Match /api/plans, not global clinical visibility: canViewAllPatients
      // does not grant access to another doctor's treatment-plan identities.
      const user = await findUserByUsername(session.username).catch(() => null);
      canReadSources = !!user?.isActive && user.permissions?.canViewPlans !== false && !!user.partyId
        && await doctorOwnsPatient(user.partyId, patientId).catch(() => false);
    }
    if (onboarding && !canReadSources) {
      onboarding.financialReference = { state: "restricted", sources: [], clinicalCaseIds: [], hasRecordedSchedule: false };
      onboarding.steps = onboarding.steps.filter((step) => step.key === "baseline");
      onboarding.complete = false;
      onboarding.warning = "تفاصيل المرجع المالي غير متاحة بصلاحيتك؛ لا يمكن تأكيد اكتمال التهيئة من هذه الشاشة.";
    }
    return NextResponse.json({ onboarding }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل تهيئة الحالة السابقة." }, { status: 500 });
  }
}

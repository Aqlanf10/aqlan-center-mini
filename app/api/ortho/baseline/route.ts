import { NextResponse } from "next/server";
import { CLINIC_TIME_ZONE, recordOrthoBaseline } from "@/lib/db";
import { checkBaselineDraft } from "@/lib/ortho-baseline";
import { clinicDateString } from "@/lib/schedule";
import { canAccessPatient } from "@/lib/patient-access";
import { idOf, json, readBody } from "@/lib/case-route";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (CASE-1) تسجيل حالة تقويمٍ سابقة (قبل النظام) — لقطةٌ لحال العلاج اليوم.
 *
 * يكتبها الطبيب أو المدير وحدهما: السلك والمرحلة والأهداف قرارٌ سريري. والاستقبال يطّلع ولا يكتب.
 * والكاشير والمحاسب خارج مسارات التقويم أصلًا (قائمة السماح عند الباب). ولا فاتورة ولا زيارة تُنشأ هنا.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return json("انتهت الجلسة. سجّل الدخول من جديد.", 401);
  if (session.role !== "doctor" && session.role !== "admin") {
    return json("تسجيل الحالة السابقة للطبيب والمدير — الاستقبال يطّلع عليها فقط.", 403);
  }
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const patientId = idOf(String(read.body.patientId ?? ""));
  if (!patientId) return json("اختر المريض أولًا.", 400);
  if (!(await canAccessPatient(session, patientId).catch(() => false))) {
    return json("غير مصرّح لك بملف هذا المريض.", 403);
  }

  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const draft = checkBaselineDraft(read.body, today);
  if (!draft.ok) return json(draft.message, 400);
  // ربط خطةٍ قائمة يحترم صلاحية عرض الخطط نفسها — فلا يصير المسار بابًا خلفيًّا حولها.
  if (draft.value.planId !== null
    && !(await canAccessPatient(session, patientId, "canViewPlans").catch(() => false))) {
    return json("عرض خطط العلاج غير مفعّل لحسابك.", 403);
  }
  // الطبيب المسؤول افتراضًا: الطبيب الذي يسجّل.
  const responsibleDoctorId = draft.value.responsibleDoctorId
    ?? (session.role === "doctor" ? session.partyId ?? null : null);

  try {
    const result = await recordOrthoBaseline({
      ...draft.value, responsibleDoctorId, patientId, actor: session.username, actorRole: session.role,
    });
    if (!result.ok) {
      const messages = {
        no_patient: ["لا يوجد مريض بهذا الرقم.", 404],
        open_case: ["للمريض حالة تقويم مفتوحة سلفًا — اللقطة السابقة تُسجَّل لمريضٍ بلا حالة جارية.", 409],
        bad_doctor: ["الطبيب المسؤول يجب أن يكون طبيبًا مسجّلًا نشطًا.", 400],
        bad_plan: ["الخطة لا تخص هذا المريض.", 400],
      } as const;
      const [message, status] = messages[result.reason];
      return json(message, status);
    }
    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch {
    return json("تعذّر تسجيل الحالة السابقة. أعد المحاولة.", 500);
  }
}

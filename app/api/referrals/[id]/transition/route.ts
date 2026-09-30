import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { findUserByUsername, getReferral, transitionInternalReferral } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { canActOnReferral, checkReferralTransition } from "@/lib/referrals";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const json = (message: string, status: number) => NextResponse.json({ message }, { status });

/**
 * (REF-1) خطوةٌ في سير الإحالة الداخلية: قبول، اعتذار، حجز (ربط موعد)، إكمال (بخلاصةٍ تعود إلى
 * المحيل)، اطّلاع المحيل، إلغاء. من يفعل ماذا: `canActOnReferral` — والمسار المسموح: الخادم.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return json("انتهت الجلسة. سجّل الدخول من جديد.", 401);
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return json("رقم إحالة غير صالح.", 400);

  let body: Record<string, unknown>;
  try { body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return json("طلب غير صالح.", 400);
  }
  const transition = checkReferralTransition(body ?? {});
  if (!transition.ok) return json(transition.message, 400);

  try {
    const referral = await getReferral(id);
    if (!referral) return json("لا توجد إحالة بهذا الرقم.", 404);
    if (!(await canAccessPatient(session, referral.patientId).catch(() => false))) {
      return json("غير مصرّح لك بملف هذا المريض.", 403);
    }
    const user = await findUserByUsername(session.username).catch(() => null);
    if (!user || !user.isActive) return json("الحساب غير نشط.", 403);
    if (!canActOnReferral({
      action: transition.value.action, role: session.role, actorPartyId: user.partyId ?? null,
      referringPartyId: referral.doctorPartyId, receivingPartyId: referral.toPartyId,
    })) {
      const who = {
        accept: "الطبيب المحال إليه", decline: "الطبيب المحال إليه", complete: "الطبيب المحال إليه",
        schedule: "الاستقبال أو الطبيب المحال إليه", cancel: "الطبيب المحيل", acknowledge: "الطبيب المحيل",
      }[transition.value.action];
      return json(`هذه الخطوة يقوم بها ${who}.`, 403);
    }
    const result = await transitionInternalReferral({
      id, ...transition.value, actor: session.username, actorRole: session.role,
    });
    if (!result.ok) {
      const messages = {
        not_found: ["لا توجد إحالة بهذا الرقم.", 404],
        external: ["هذه إحالة خارجية — تُغلق بنتيجتها من خطابها.", 409],
        invalid_transition: ["لا تصحّ هذه الخطوة في حالة الإحالة الآن — حدّث الصفحة.", 409],
        bad_appointment: ["اختر موعدًا محجوزًا لهذا المريض مع الطبيب المحال إليه، غير مرتبطٍ بإحالةٍ أخرى.", 400],
      } as const;
      const [message, status] = messages[result.reason];
      return json(message, status);
    }
    return NextResponse.json(result.referral);
  } catch {
    return json("تعذّر تحديث الإحالة. أعد المحاولة.", 500);
  }
}

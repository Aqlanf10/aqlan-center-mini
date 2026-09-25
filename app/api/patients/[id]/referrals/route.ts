import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createReferral, findUserByUsername, listPatientReferrals } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { clinicalCapabilityOf } from "@/lib/clinical-identity";
import { checkReferralDraft } from "@/lib/referrals";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

function patientIdOf(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** (P3-8) إحالات المريض — يراها كل من يملك الوصول إلى ملفه. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = patientIdOf((await params).id);
  if (!patientId) return NextResponse.json({ message: "رقم مريض غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, patientId).catch(() => false))) {
    return NextResponse.json({ message: "غير مصرّح لك بملف هذا المريض." }, { status: 403 });
  }
  try {
    return NextResponse.json(await listPatientReferrals(patientId));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الإحالات." }, { status: 500 });
  }
}

/**
 * (P3-8) إصدار إحالة: خطابٌ باسم طبيبٍ سريري — الطبيب، أو مديرٌ مرتبط بجهة طبيب
 * (الفحص المركزي نفسه الذي يحرس الوصفات). الاستقبال يسجّل النتيجة ولا يصدر الخطاب.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = patientIdOf((await params).id);
  if (!patientId) return NextResponse.json({ message: "رقم مريض غير صالح." }, { status: 400 });

  const user = await findUserByUsername(session.username).catch(() => null);
  if (!user || !user.isActive) return NextResponse.json({ message: "الحساب غير نشط." }, { status: 403 });
  if (session.role === "reception") {
    return NextResponse.json({ message: "خطاب الإحالة يصدره الطبيب المعالج — الاستقبال يسجّل نتيجتها فقط." }, { status: 403 });
  }
  const capability = clinicalCapabilityOf({ role: session.role, doctorPartyId: user.partyId });
  if (!capability.ok) return NextResponse.json({ message: capability.reason }, { status: 403 });
  if (!(await canAccessPatient(session, patientId).catch(() => false))) {
    return NextResponse.json({ message: "غير مصرّح لك بإحالة هذا المريض." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES); } catch (error) {
    const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const draft = checkReferralDraft(body ?? {});
  if (!draft.ok) return NextResponse.json({ message: draft.message }, { status: 400 });

  try {
    const referral = await createReferral({
      ...draft.value, patientId, doctorPartyId: capability.partyId,
      actor: session.username, actorRole: session.role,
    });
    if (!referral) return NextResponse.json({ message: "لا يوجد مريض بهذا الرقم." }, { status: 404 });
    return NextResponse.json(referral, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الإحالة. أعد المحاولة." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { findUserByUsername, getPrescription, voidPrescription } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { checkVoidReason } from "@/lib/prescription";
import { clinicalCapabilityOf, isIssuingClinician } from "@/lib/clinical-identity";

export const dynamic = "force-dynamic";

/**
 * إبطال وصفة — بسببٍ مكتوب لا حذف.
 *
 * المريض خرج بنسخته فتعديل المحفوظ يجعل نسختين يقولان شيئين؛ والصحيح إبطالٌ
 * موثَّق بالسبب واسم من أبطل، ثم وصفةٌ جديدة تصدر مكانها.
 *
 * حرس الباب (P0.8): الوصفة تُحلّ إلى مريضها ثم يُطبَّق عزل الطبيب —
 * الطبيب A لا يُبطل وصفة مريض الطبيب B ولو عرف رقمها (BOLA).
 *
 * **سلطة المُصدر (مراجعة P0 المستقلة):** الوصول إلى المريض لا يعني حق إبطال
 * وصفة زميل. القاعدة الافتراضية:
 * - الطبيب يُبطل **وصفته هو فقط** (prescription.doctorPartyId === جهته).
 * - طبيبٌ آخر — ولو كان المريض مشتركًا بينهما (canAccessPatient=true) — مرفوض.
 * - المدير الإداري بلا هوية سريرية لا يتصرف كطبيب تلقائيًا؛ والمدير المرتبط
 *   صراحةً بجهة طبيب يُبطل وصفاته هو كالطبيب. (لو احتُج override مستقبلي
 *   فيُعرَّف صلاحيةً صريحةً مُدقَّقة — لا نتيجةً لـ role=admin وحده.)
 *
 * كل إبطال يُدقَّق بـ: رقم الوصفة، المريض، جهة مُصدرها، جهة/مستخدم مُبطِلها،
 * السبب، والزمن.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role) && session.role !== "doctor") {
    return NextResponse.json({ message: "إبطال الوصفات للطبيب والمدير." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم وصفة غير صالح." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try { body = (await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES)); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const check = checkVoidReason(body.reason);
  if (!check.ok) {
    return NextResponse.json({ message: check.reason }, { status: 400 });
  }

  /* العزل قبل الإبطال: وصفة مريض زميلٍ لا تُبطل — تُحلّ لمريضها وتُفحص الملكية. */
  const prescription = await getPrescription(id).catch(() => null);
  if (!prescription) {
    return NextResponse.json({ message: "الوصفة غير موجودة." }, { status: 404 });
  }
  if (!(await canAccessPatient(session, prescription.patientId))) {
    return NextResponse.json(
      { message: "غير مصرّح لك بإبطال وصفة هذا المريض (عزل الكادر السريري)." },
      { status: 403 },
    );
  }

  /* سلطة المُصدر — الفحص المركزي للقدرة السريرية ثم مطابقة جهة الإصدار.
     هوية المُبطِل تُقرأ من الخادم (الحساب) لا من الجلسة وحدها. */
  const user = await findUserByUsername(session.username).catch(() => null);
  if (!user || !user.isActive) {
    return NextResponse.json({ message: "الحساب غير نشط أو غير موجود." }, { status: 403 });
  }
  const capability = clinicalCapabilityOf({ role: session.role, doctorPartyId: user.partyId });
  if (!capability.ok) {
    return NextResponse.json(
      { message: `إبطال الوصفات يقتضي هوية مُصدر سريرية: ${capability.reason}` },
      { status: 403 },
    );
  }
  const issuer = { partyId: capability.partyId, username: session.username };
  if (!isIssuingClinician(prescription, issuer)) {
    const issuedBy =
      prescription.doctorPartyId != null
        ? `أصدرها طبيب آخر (جهة #${prescription.doctorPartyId})`
        : `أصدرها حساب «${prescription.createdBy}»`;
    return NextResponse.json(
      {
        message: `لا يُبطل وصفةً إلا مُصدرها — هذه الوصفة ${issuedBy}. الوصول إلى المريض لا يمنح حق إبطال وصفة زميل؛ عالِج الأمر مع مُصدرها أو عبر صلاحية صريحة من الإدارة.`,
      },
      { status: 403 },
    );
  }

  try {
    const result = await voidPrescription(
      {
        id,
        reason: check.reason,
        actor: session.username,
        issuingDoctorPartyId: prescription.doctorPartyId ?? null,
        patientId: prescription.patientId,
      },
      capability.partyId,
    );
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر إبطال الوصفة." }, { status: 500 });
  }
}

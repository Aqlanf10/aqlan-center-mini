import { NextResponse } from "next/server";
import { createIntakeForm, listIntakeForms } from "@/lib/db";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canAccessPatient } from "@/lib/patient-access";
import { validateIntake } from "@/lib/portal";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * سجل الاستمارات الصحية كما قالها المريض — الأحدث أولًا.
 *
 * منفصلٌ قصدًا عن «التنبيه الطبي» الذي يوثّقه الطبيب: كلام المريض لا يتحول تلقائيًا
 * إلى تشخيص. والسجل إضافيّ: الطاقم يدوّن تحديثًا نسخةً جديدة (POST)، ولا مسار يعدّل
 * نسخةً سابقة أو يحذفها.
 */
async function guard(context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return { error: NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE }) };
  }
  const patientId = Number((await context.params).id);
  if (!Number.isInteger(patientId) || patientId <= 0) {
    return { error: NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400, headers: NO_STORE }) };
  }
  if (!(await canAccessPatient(session, patientId))) {
    return { error: NextResponse.json({ message: "غير مصرّح لك بالاطلاع على هذا الملف." }, { status: 403, headers: NO_STORE }) };
  }
  return { session, patientId };
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const checked = await guard(context);
  if ("error" in checked) return checked.error;
  try {
    return NextResponse.json({ forms: await listIntakeForms(checked.patientId) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل تاريخ الاستمارات الصحية." }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const checked = await guard(context);
  if ("error" in checked) return checked.error;
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400, headers: NO_STORE });
  }
  const validation = validateIntake(body);
  if (!validation.ok) return NextResponse.json({ message: validation.message }, { status: 400, headers: NO_STORE });
  try {
    const created = await createIntakeForm(checked.patientId, validation.value, {
      actor: checked.session.username, actorRole: checked.session.role,
    });
    return NextResponse.json(created, { status: 201, headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الاستمارة." }, { status: 500, headers: NO_STORE });
  }
}

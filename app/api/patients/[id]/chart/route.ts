import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { patientChart, recordAudit, recordToothCondition, ToothVisitConflict } from "@/lib/db";
import { CONDITION_LABEL, STAGE_LABEL, isValidTooth, toothName,
  type ConditionStage, type ToothCondition } from "@/lib/dental";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const patientIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بالاطلاع على مخطط هذا المريض." }, { status: 403 });
  }

  try {
    return NextResponse.json(await patientChart(patientId));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل مخطط الأسنان." }, { status: 500 });
  }
}

/**
 * تثبيت حالة سن.
 *
 * **الطبيب والمدير فقط.** المخطط السني سجلٌّ طبي: من يكتب فيه يوقّع على تشخيص، وهذا
 * ليس عمل الاستقبال. والدور يُفحص هنا لا في الواجهة وحدها.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (session.role !== "doctor" && session.role !== "admin") {
    return NextResponse.json({ message: "المخطط السني للطبيب والمدير." }, { status: 403 });
  }
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بتعديل مخطط هذا المريض." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  // Omitted/null means a standalone chart event. A malformed supplied link must
  // not silently become null (or be coerced from a boolean/array into another visit).
  let visitId: number | null = null;
  if (source.visitId !== undefined && source.visitId !== null) {
    const raw = source.visitId;
    if ((typeof raw !== "number" && !(typeof raw === "string" && /^\d+$/.test(raw)))
      || !Number.isInteger(Number(raw)) || Number(raw) <= 0 || Number(raw) > 2_147_483_647) {
      return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
    }
    visitId = Number(raw);
  }

  const toothCode = Number(source.toothCode);
  if (!isValidTooth(toothCode)) {
    return NextResponse.json({ message: "رقم السن غير صالح بترقيم FDI." }, { status: 400 });
  }
  const condition = String(source.condition ?? "") as ToothCondition;
  if (!(condition in CONDITION_LABEL)) {
    return NextResponse.json({ message: "حالة السن غير معروفة." }, { status: 400 });
  }
  const stage = String(source.stage ?? "existing") as ConditionStage;
  if (!(stage in STAGE_LABEL)) {
    return NextResponse.json({ message: "مرحلة الحالة غير معروفة." }, { status: 400 });
  }

  try {
    const record = await recordToothCondition({
      patientId, toothCode, condition, stage,
      surfaces: typeof source.surfaces === "string" ? source.surfaces : null,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
      visitId,
      recordedBy: session.username,
    });
    if (!record) return NextResponse.json({ message: "المريض غير موجود." }, { status: 404 });

    await recordAudit({
      action: "chart.record", entity: "patient", entityId: patientId,
      entityLabel: `${toothName(toothCode)} — ${CONDITION_LABEL[condition]} (${STAGE_LABEL[stage]})`,
      details: { السن: toothCode, الحالة: condition, المرحلة: stage, الأسطح: record.surfaces },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(record, { status: 201 });
  } catch (error) {
    if (error instanceof ToothVisitConflict) {
      return NextResponse.json({ message: error.message }, { status: 409 });
    }
    return NextResponse.json({ message: "تعذّر حفظ حالة السن." }, { status: 500 });
  }
}

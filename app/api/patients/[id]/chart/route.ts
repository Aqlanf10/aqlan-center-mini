import { NextResponse } from "next/server";
import { patientChart, recordAudit, recordToothCondition } from "@/lib/db";
import { CONDITION_LABEL, STAGE_LABEL, isValidTooth, toothName,
  type ConditionStage, type ToothCondition } from "@/lib/dental";
import { requireSession } from "@/lib/session";

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

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

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
      visitId: Number(source.visitId) || null,
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
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ حالة السن." }, { status: 500 });
  }
}

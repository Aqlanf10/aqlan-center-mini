import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  DiagnosisAssociationError, listPatientDiagnoses,
  recordAudit, recordPatientDiagnosis,
} from "@/lib/db";
import { validateDiagnosisContent } from "@/lib/diagnosis";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const patientIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;
};

// Omitted/null is standalone; an explicit malformed link must never become null.
const parseCaseId = (value: unknown): number | null | "invalid" => {
  if (value === undefined || value === null) return null;
  if ((typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value)))
    || !Number.isInteger(Number(value)) || Number(value) <= 0 || Number(value) > 2_147_483_647) return "invalid";
  return Number(value);
};

/** تاريخ التشخيص — كل النسخ، الأحدث أولًا. لا يُعدّل شيء هنا: تاريخٌ يُقرأ. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });

  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }

  const query = new URL(request.url).searchParams;
  const orthoCaseId = parseCaseId(query.get("orthoCaseId"));
  if (orthoCaseId === "invalid" || query.getAll("orthoCaseId").length > 1) {
    return NextResponse.json({ message: "رقم حالة التقويم غير صالح." }, { status: 400 });
  }
  try {
    // No query keeps the original complete, patient-wide history contract.
    return NextResponse.json({ diagnoses: orthoCaseId === null
      ? await listPatientDiagnoses(patientId)
      : await listPatientDiagnoses(patientId, orthoCaseId) });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل التشخيص." }, { status: 500 });
  }
}

/**
 * نسخة تشخيص جديدة — التحديث هنا نسخةٌ جديدة لا تعديل.
 *
 * ما كتبه الطبيب يوم بدء العلاج يبقى كما هو، وكل تحديثٍ يشير إلى سابقه — فيُقرأ
 * بعد سنوات ما رأى الطبيب ومتى، لا آخرُ كلامٍ صيغ بأثر رجعي.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (session.role !== "doctor" && session.role !== "admin") {
    return NextResponse.json({ message: "تسجيل التشخيص للطبيب والمدير." }, { status: 403 });
  }
  const patientId = await patientIdFrom(context);
  if (!patientId) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });

  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const check = validateDiagnosisContent(source.content);
  if (!check.ok) return NextResponse.json({ message: check.message }, { status: 400 });

  const label = typeof source.label === "string" && source.label.trim()
    ? source.label.trim().slice(0, 120) : null;
  const orthoCaseId = parseCaseId(source.orthoCaseId);
  if (orthoCaseId === "invalid") {
    return NextResponse.json({ message: "رقم حالة التقويم غير صالح." }, { status: 400 });
  }

  try {
    const saved = await recordPatientDiagnosis({
      patientId,
      content: check.content as unknown as Record<string, unknown>,
      label,
      orthoCaseId,
      visitId: null,
      createdBy: session.username,
    });
    void recordAudit({
      action: "diagnosis.create",
      entity: "patient_diagnoses",
      entityId: saved.id,
      entityLabel: `نسخة ${saved.version}`,
      details: { المريض: patientId, النسخة: saved.version },
      actor: session.username,
      actorRole: session.role,
    });
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    if (error instanceof DiagnosisAssociationError) {
      return NextResponse.json({ message: error.message }, { status: 400 });
    }
    return NextResponse.json({ message: "تعذّر حفظ التشخيص. أعد المحاولة." }, { status: 500 });
  }
}

import { parseCephCorrectionCommand } from "@/lib/ceph-correction-origin";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import {ClinicalMutationAuthorityError} from '@/lib/clinical-mutation-authority';
import { NextResponse } from "next/server";
import { duplicateAuthorizedCephAnalysis, getCephStudy } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * نسخة تصحيح عن تحليل معتمد.
 *
 * طريقُ التعديل الوحيد بعد الاعتماد: المعتمد يبقى كما خُتم، والنسخة مسودةٌ جديدة
 * على الشععة نفسها بمعالمها ومعايرتها — يعدّل الطبيب ما غيّره ثم يعتمد من جديد.
 * وبهذا يبقى في السجل تاريخٌ كامل: ما قيل أولًا، وما قيل بعده، ومن قال.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const { id: raw } = await context.params;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });
  }

  const study = await getCephStudy(id);
  if (!study) {
    return NextResponse.json({ message: "التحليل غير موجود." }, { status: 404 });
  }
  if (!(await canAccessPatient(session, study.analysis.patientId, "canUploadXrays"))) {
    return NextResponse.json({ message: "غير مصرّح لك بفتح نسخة عن هذا التحليل." }, { status: 403 });
  }

  let rawCommand: unknown;
  try { rawCommand = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); }
  catch (error) { return bodyErrorResponse(error) ?? NextResponse.json({message:"طلب غير صالح."},{status:400}); }
  const command = parseCephCorrectionCommand(rawCommand);
  if (!command || command.expectedCorrectionSource.analysisId !== id) return NextResponse.json({message:"هوية أصل التصحيح مطلوبة؛ أعد فتح الدراسة وراجعها."},{status:400});
  try {
    const created = await duplicateAuthorizedCephAnalysis(id, {patientId:study.analysis.patientId,documentId:study.analysis.documentId,session},command.expectedCorrectionSource);
    if (!created.ok) return NextResponse.json({ message: created.message }, { status: 409 });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (error) {
    if (error instanceof ClinicalMutationAuthorityError) return NextResponse.json({message:error.message},{status:error.status});
    return NextResponse.json({ message: "تعذّر فتح نسخة التصحيح." }, { status: 500 });
  }
}

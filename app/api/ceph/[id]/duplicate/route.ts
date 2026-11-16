import { NextResponse } from "next/server";
import { duplicateCephAnalysis, getCephStudy } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { canonicalPatientReadFailure, NO_STORE } from "@/lib/canonical-patient-http";
import { CanonicalCephCopyRefusal, commandCanonicalCephCopy } from "@/lib/canonical-ceph-copy-command";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";

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
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const body: unknown = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      if ([...new URL(request.url).searchParams.keys()].length) throw new CanonicalCephCopyRefusal("invalid_ceph_copy", 400, "طلب التصحيح لا يقبل مرشحات إضافية.");
      return NextResponse.json(await commandCanonicalCephCopy(selected.handle, (await context.params).id, body), { status: 201, headers: NO_STORE });
    } catch (error) {
      const bounded = bodyErrorResponse(error);
      if (bounded) { bounded.headers.set("Cache-Control", "private, no-store"); return bounded; }
      if (error instanceof CanonicalCephCopyRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      return canonicalPatientReadFailure(error, "تعذّر تأكيد نسخة التصحيح. حدّث الدراسات وتحقق من النتيجة قبل أي طلب جديد.");
    }
  }
  const session = await requireSession();
  if (!session) return denied();
  const { id: raw } = await context.params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });
  }

  const study = await getCephStudy(id);
  if (!study) {
    return NextResponse.json({ message: "التحليل غير موجود." }, { status: 404 });
  }
  if (!(await canAccessPatient(session, study.analysis.patientId, "canUploadXrays"))) {
    return NextResponse.json({ message: "غير مصرّح لك بفتح نسخة عن هذا التحليل." }, { status: 403 });
  }

  try {
    const created = await duplicateCephAnalysis(id, session.username);
    if (!created.ok) return NextResponse.json({ message: created.message }, { status: 409 });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر فتح نسخة التصحيح." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { recordAudit, setPatientPhoto } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";
import { isRestrictedRole } from "@/lib/role-routes";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const REFUSAL: Record<"not_found" | "document_not_found" | "not_image", { message: string; status: 400 | 404 }> = {
  not_found: { message: "المريض غير موجود.", status: 404 },
  document_not_found: { message: "الصورة ليست من مستندات هذا المريض أو أُخفيت.", status: 404 },
  not_image: { message: "اختر صورة (JPG أو PNG) لا ملفًّا آخر.", status: 400 },
};

/** (PAT-3) صورة المريض: مستندٌ صوريٌّ من مستنداته، أو null لإزالتها. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  if (isRestrictedRole(session.role)) {
    return NextResponse.json({ message: "تعديل صورة المريض ليس من صلاحيتك." }, { status: 403 });
  }
  const patientId = Number((await context.params).id);
  if (!Number.isInteger(patientId) || patientId <= 0) return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
  if (!(await canAccessPatient(session, patientId))) {
    return NextResponse.json({ message: "هذا الملف ليس من مرضاك." }, { status: 403 });
  }
  let body: Record<string, unknown>;
  try {
    const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
    body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  } catch (error) {
    return bodyErrorResponse(error) ?? NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const documentId = body.documentId === null ? null : Number(body.documentId);
  if (documentId !== null && (!Number.isInteger(documentId) || documentId <= 0)) {
    return NextResponse.json({ message: "اختر صورة من مستندات المريض." }, { status: 400 });
  }
  try {
    const result = await setPatientPhoto(patientId, documentId);
    if (!result.ok) return NextResponse.json({ message: REFUSAL[result.reason].message }, { status: REFUSAL[result.reason].status });
    await recordAudit({
      action: "patient.photo", entity: "patient", entityId: patientId,
      entityLabel: `${result.patient.fullName} (${result.patient.patientNumber})`,
      details: { المستند: documentId },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json(result.patient);
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ صورة المريض." }, { status: 500 });
  }
}

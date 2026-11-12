import { applyCephDraftEdit, parseCephDraftEdit } from "@/lib/ceph-draft-edit";
import { ClinicalMutationAuthorityError } from "@/lib/clinical-mutation-authority";
import { CanonicalCephEditRefusal, commandCanonicalCephEdit } from "@/lib/canonical-ceph-edit-command";
import { CanonicalCephDiscardRefusal, commandCanonicalCephDiscard } from "@/lib/canonical-ceph-discard-command";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE,canonicalPatientReadFailure } from "@/lib/canonical-patient-http";
import { CanonicalCephReadRefusal,canonicalCephReadId,readCanonicalCephStudy } from "@/lib/canonical-ceph-reads";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { discardAuthorizedCephAnalysis, getCephStudy } from "@/lib/db";
import { canWriteCephClinical } from "@/lib/ceph-access";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * تحليل سيفالومتري واحد: قراءة، وكتابة مسودة، ورفض.
 *
 * الكتابة كلها تمرّ من دوالّ النطاق التي ترفض المس بمعتمد — والمسار هنا مجرد
 * باب يتحقق من شكل الطلب. والرفض (DELETE) إخفاءٌ موثَّق للمسودة لا حذفًا: صفٌّ
 * يبقى بشهادة رافضه، كما في المستندات.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const forbidden = () =>
  NextResponse.json({ message: "غير مصرّح لك بالوصول لهذا التحليل." }, { status: 403 });

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const selected=await selectRequestStaffEnvelope();
  if(selected.kind==="denied")return NextResponse.json({message:"انتهت الجلسة. سجّل الدخول من جديد."},{status:401,headers:NO_STORE});
  if(selected.kind==="canonical") {
    try {
      const id=canonicalCephReadId((await context.params).id,new URL(_request.url).searchParams);
      return NextResponse.json(await readCanonicalCephStudy(selected.handle,id),{headers:NO_STORE});
    } catch(error) {
      if(error instanceof CanonicalCephReadRefusal)return NextResponse.json({code:error.code,message:error.message},{status:409,headers:NO_STORE});
      return canonicalPatientReadFailure(error,"تعذّر قراءة دراسة السيفالومتري؛ لم تُعتبر النتائج فارغة.");
    }
  }
  const session = await requireSession();
  if (!session) return denied();
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });

  try {
    const study = await getCephStudy(id);
    if (!study) return NextResponse.json({ message: "التحليل غير موجود." }, { status: 404 });
    if (!(await canAccessPatient(session, study.analysis.patientId, "canViewXrays"))) {
      return forbidden();
    }
    return NextResponse.json(study);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل التحليل." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const body: unknown = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      if ([...new URL(request.url).searchParams.keys()].length) throw new CanonicalCephEditRefusal("invalid_ceph_edit", 400, "حفظ المسودة لا يقبل مرشحات إضافية.");
      return NextResponse.json(await commandCanonicalCephEdit(selected.handle, (await context.params).id, body), { headers: NO_STORE });
    } catch (error) {
      const bounded = bodyErrorResponse(error);
      if (bounded) { bounded.headers.set("Cache-Control", "private, no-store"); return bounded; }
      if (error instanceof CanonicalCephEditRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      return canonicalPatientReadFailure(error, "تعذّر تأكيد حفظ المسودة. تحقق من الدراسة الحالية قبل أي طلب جديد.");
    }
  }
  const session = await requireSession();
  if (!session) return denied();
  if (!canWriteCephClinical(session.role)) return forbidden();
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });

  const study = await getCephStudy(id);
  if (!study) return NextResponse.json({ message: "التحليل غير موجود." }, { status: 404 });
  if (!(await canAccessPatient(session, study.analysis.patientId, "canUploadXrays").catch(() => false))) {
    return forbidden();
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const parsed = parseCephDraftEdit(body);
  if (!parsed.ok) return NextResponse.json({ message: parsed.message }, { status: 400 });
  try {
    const done = await applyCephDraftEdit(id, parsed.edit, { patientId: study.analysis.patientId, documentId: study.analysis.documentId, session });
    if (!done.ok) return NextResponse.json({ message: done.message }, { status: 409 });
    return NextResponse.json(done.body);
  } catch (error) {
    if (error instanceof ClinicalMutationAuthorityError) return NextResponse.json({ message: error.message }, { status: error.status });
    return NextResponse.json({ message: "تعذّر حفظ التعديل." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    try {
      const body: unknown = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
      if ([...new URL(request.url).searchParams.keys()].length) throw new CanonicalCephDiscardRefusal("invalid_ceph_discard", 400, "رفض المسودة لا يقبل مرشحات إضافية.");
      return NextResponse.json(await commandCanonicalCephDiscard(selected.handle, (await context.params).id, body), { headers: NO_STORE });
    } catch (error) {
      const bounded = bodyErrorResponse(error);
      if (bounded) { bounded.headers.set("Cache-Control", "private, no-store"); return bounded; }
      if (error instanceof CanonicalCephDiscardRefusal) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status, headers: NO_STORE });
      return canonicalPatientReadFailure(error, "تعذّر تأكيد رفض المسودة. تحقق من حالتها قبل أي طلب جديد.");
    }
  }
  const session = await requireSession();
  if (!session) return denied();
  if (!["admin", "reception", "doctor"].includes(session.role)) return forbidden();
  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });

  const study = await getCephStudy(id);
  if (!study) return NextResponse.json({ message: "التحليل غير موجود." }, { status: 404 });
  if (!(await canAccessPatient(session, study.analysis.patientId, "canUploadXrays").catch(() => false))) {
    return forbidden();
  }

  let note: string | null = null;
  try {
    const body = (await readJsonBody<Record<string, unknown> | null>(request, JSON_BODY_LIMIT_BYTES));
    if (body && typeof body.note === "string") note = body.note;
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; /* الرفض بلا ملاحظة جائز */ }

  try {
    const done = await discardAuthorizedCephAnalysis(id, note, { patientId: study.analysis.patientId, documentId: study.analysis.documentId, session });
    if (!done.ok) return NextResponse.json({ message: done.message }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ClinicalMutationAuthorityError) return NextResponse.json({ message: error.message }, { status: error.status });
    return NextResponse.json({ message: "تعذّر رفض المسودة." }, { status: 500 });
  }
}

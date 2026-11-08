import { isCephDiagnosisWriteInput } from "@/lib/ceph-diagnosis-write-input";
import { ClinicalMutationAuthorityError } from "@/lib/clinical-mutation-authority";
import { parseCephCalibrationState, parseCephCompletionDiagnosis, type CephCalibrationState, type CephCompletionDiagnosis } from "@/lib/ceph-completion-snapshot";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  discardAuthorizedCephAnalysis, getCephStudy, updateAuthorizedCephCalibration, updateAuthorizedCephDiagnosis, updateAuthorizedCephLandmarks,
  type CephCalibrationInput, type CephLandmarkInput,
} from "@/lib/db";
import { isCephLandmarkCode } from "@/lib/ceph";
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

const num = (v: unknown): number | null => {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
};

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
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
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const invalid = (message = "طلب غير صالح.") => NextResponse.json({ message }, { status: 400 });
  if (!record(body)) return invalid();
  const source = body;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(source, key);
  // Each category owns a separate domain transaction; do not partially commit mixed requests.
  const categories = [has("calibration"), has("landmarks") || has("removeLandmarks"), has("diagnosis")];
  if (categories.filter(Boolean).length > 1) return invalid("أرسل تعديل المعايرة أو المعالم أو التشخيص في طلب مستقل.");
  const parsePoints = (value: unknown): CephLandmarkInput[] | null => {
    if (!Array.isArray(value)) return null;
    const parsed: CephLandmarkInput[] = [];
    for (const raw of value) {
      if (!record(raw) || !isCephLandmarkCode(raw.code) || num(raw.x) === null || num(raw.y) === null
        || (raw.source !== undefined && raw.source !== "manual" && raw.source !== "suggested")) return null;
      parsed.push({ code: raw.code, x: raw.x as number, y: raw.y as number, source: raw.source === "suggested" ? "suggested" : "manual" });
    }
    return new Set(parsed.map((pt) => pt.code)).size === parsed.length ? parsed : null;
  };

  // Validate every requested field before the first write. In particular an
  // invalid landmark batch must not partially save a new calibration.
  let calibration: CephCalibrationInput | undefined;
  let expectedCalibration: CephCalibrationState | undefined;
  if (has("calibration")) {
    if (!record(source.calibration)) return invalid();
    const c = source.calibration;
    const x1 = num(c.x1), y1 = num(c.y1), x2 = num(c.x2), y2 = num(c.y2), mm = num(c.mm);
    if (x1 === null || y1 === null || x2 === null || y2 === null || mm === null || mm <= 0
      || !Number.isFinite(Math.hypot(x2 - x1, y2 - y1)) || Math.hypot(x2 - x1, y2 - y1) <= 0) {
      return invalid("المعايرة تحتاج نقطتين مختلفتين ومسافة حقيقية بالمليمتر.");
    }
    const scale = mm / Math.hypot(x2 - x1, y2 - y1);
    if (!Number.isFinite(scale) || scale <= 0) return invalid("مقياس المعايرة غير صالح.");
    calibration = { x1, y1, x2, y2, mm };
    const expected = parseCephCalibrationState(source.expectedCalibration);
    if (!expected) return invalid("حفظ المعايرة يحتاج نسخة المعايرة السابقة التي راجعتها.");
    expectedCalibration = expected;
  }
  const points = has("landmarks") ? parsePoints(source.landmarks) : [];
  if (points === null) return invalid("المعالم تحتاج رموزًا فريدة وإحداثيات رقمية صالحة.");
  const removeCodes = has("removeLandmarks") ? source.removeLandmarks : [];
  if (!Array.isArray(removeCodes) || !removeCodes.every(isCephLandmarkCode)
    || new Set(removeCodes).size !== removeCodes.length || points.some((pt) => removeCodes.includes(pt.code))) {
    return invalid("رموز المعالم المراد إزالتها غير صالحة أو متكررة.");
  }
  if ((has("landmarks") || has("removeLandmarks")) && !Array.isArray(source.expectedLandmarks)) {
    return invalid("حفظ المعالم يحتاج مواضعها السابقة التي راجعتها؛ أرسل قائمة صريحة ولو كانت فارغة.");
  }
  const expected = has("expectedLandmarks") ? parsePoints(source.expectedLandmarks) : undefined;
  if (expected === null || removeCodes.some((code) => !expected?.some((pt) => pt.code === code))) {
    return invalid("إزالة المعلم تحتاج موضعه المحفوظ للتحقق من عدم تغيّره.");
  }
  let diagnosis: Parameters<typeof updateAuthorizedCephDiagnosis>[1] | undefined;
  let expectedDiagnosis: CephCompletionDiagnosis | null | undefined;
  if (has("diagnosis")) {
    const d = source.diagnosis;
    if (!isCephDiagnosisWriteInput(d)) {
      return invalid("حقول التشخيص يجب أن تكون نصًا أو فارغة؛ الحد 2000 حرف لكل حقل والاستنتاج مطلوب.");
    }
    const expected = source.expectedDiagnosis === null ? null : parseCephCompletionDiagnosis(source.expectedDiagnosis);
    if (source.expectedDiagnosis !== null && !expected) return invalid("حفظ التشخيص يحتاج نسخته السابقة التي راجعتها.");
    expectedDiagnosis = expected;
    diagnosis = {
      skeletal: typeof d.skeletal === "string" ? d.skeletal : null,
      dental: typeof d.dental === "string" ? d.dental : null,
      softTissue: typeof d.softTissue === "string" ? d.softTissue : null,
      note: typeof d.note === "string" ? d.note : null,
      finalDx: d.finalDx,
    };
  }

  try {
    const authority = { patientId: study.analysis.patientId, documentId: study.analysis.documentId, session };
    let mmPerPixel: number | undefined;
    let savedCalibration: CephCalibrationInput | undefined;
    let savedDiagnosis: CephCompletionDiagnosis | undefined;
    if (calibration) {
      const done = await updateAuthorizedCephCalibration(id, calibration, expectedCalibration!, authority);
      if (!done.ok) return NextResponse.json({ message: done.message }, { status: 409 });
      mmPerPixel = done.mmPerPixel;
      savedCalibration = done.calibration;
    }
    if (has("landmarks") || has("removeLandmarks")) {
      const done = await updateAuthorizedCephLandmarks(id, points, removeCodes, expected!, authority);
      if (!done.ok) return NextResponse.json({ message: done.message }, { status: 409 });
    }
    if (diagnosis) {
      const done = await updateAuthorizedCephDiagnosis(id, diagnosis, expectedDiagnosis!, authority);
      if (!done.ok) return NextResponse.json({ message: done.message }, { status: 409 });
      savedDiagnosis = done.diagnosis;
    }
    return NextResponse.json({ ok: true, ...(mmPerPixel === undefined ? {} : { mmPerPixel, calibration: savedCalibration }),
      ...(savedDiagnosis === undefined ? {} : { diagnosis: savedDiagnosis }) });
  } catch (error) {
    if (error instanceof ClinicalMutationAuthorityError) return NextResponse.json({ message: error.message }, { status: error.status });
    return NextResponse.json({ message: "تعذّر حفظ التعديل." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
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

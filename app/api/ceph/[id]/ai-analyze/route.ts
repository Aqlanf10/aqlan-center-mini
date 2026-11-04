import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  getCephStudy, getPatient, updateCephLandmarks,
} from "@/lib/db";
import {
  suggestLandmarks,
  type LandmarkCode, type Pt,
} from "@/lib/ceph";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * مسار الذكاء الاصطناعي السيفالومتري — تحليل واقتراح.
 *
 * القاعدة الدستورية الطبية (ZONE_B):
 * «الذكاء الاصطناعي يقترح ولا يعتمد.»
 * كل معلم يقترحه هذا المسار يحمل الوسم source: 'suggested' ولا يصير نهائيًا
 * إلا بتأكيد الطبيب واعتماده اليدوي.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const forbidden = () =>
  NextResponse.json({ message: "غير مصرّح لك بالوصول لهذا التحليل." }, { status: 403 });

const idFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();

  const id = await idFrom(context);
  if (!id) return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400 });

  let body: {
    action?: "suggest-landmarks" | "generate-diagnosis";
    imageWidth?: number;
    imageHeight?: number;
    save?: boolean;
    saveToDiagnosis?: boolean;
    useAiChat?: boolean;
  };

  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح — مطلوب JSON." }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ message: "طلب غير صالح — مطلوب كائن JSON." }, { status: 400 });
  }

  const study = await getCephStudy(id);
  if (!study) {
    return NextResponse.json({ message: "التحليل غير موجود أو مرفوض." }, { status: 404 });
  }
  if (!(await canAccessPatient(session, study.analysis.patientId, "canViewXrays"))) {
    return forbidden();
  }

  // 1) خيار اقتراح المعالم الذكي
  if (body.action === "suggest-landmarks") {
    const currentPoints: Partial<Record<LandmarkCode, Pt>> = {};
    for (const lm of study.landmarks) {
      currentPoints[lm.code] = { x: lm.x, y: lm.y };
    }

    const width = Number(body.imageWidth) > 0 ? Number(body.imageWidth) : 1600;
    const height = Number(body.imageHeight) > 0 ? Number(body.imageHeight) : 1600;

    const patient = await getPatient(study.analysis.patientId);
    let age: number | undefined;
    if (patient?.birthYear) {
      const refYear = study.analysis.xrayDate
        ? new Date(study.analysis.xrayDate).getUTCFullYear()
        : new Date().getUTCFullYear();
      age = Math.max(1, refYear - patient.birthYear);
    }

    const suggestedMap = suggestLandmarks(width, height, currentPoints, { age, gender: patient?.gender });

    const suggestedPoints = (Object.entries(suggestedMap) as [LandmarkCode, Pt][]).map(([code, pt]) => ({
      code,
      x: pt.x,
      y: pt.y,
      // القاعدة الدستورية: المصدر دائمًا 'suggested'
      source: "suggested" as const,
    }));

    let saved = false;
    if (body.save && study.analysis.status === "draft") {
      const res = await updateCephLandmarks(id, suggestedPoints, session.username);
      saved = res.ok;
    }

    return NextResponse.json({
      ok: true,
      action: "suggest-landmarks",
      landmarks: suggestedPoints,
      saved,
    });
  }

  // Retired clinical inference is closed even for old clients with save flags.
  // Preserve existing diagnosis records; manual edits use the scoped PATCH route.
  if (body.action === "generate-diagnosis") {
    return NextResponse.json({
      code: "clinical_review_required",
      message: "التشخيص وخطة العلاج يحررهما الطبيب بعد مراجعة القياسات والسجلات. التوليد الآلي غير متاح.",
    }, { status: 409 });
  }

  return NextResponse.json({ message: "الإجراء action غير مدعوم." }, { status: 400 });
}

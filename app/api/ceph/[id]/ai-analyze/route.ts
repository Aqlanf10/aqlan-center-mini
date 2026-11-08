import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getCephStudy } from "@/lib/db";
import {
  computeAll,
  type LandmarkCode, type Pt,
} from "@/lib/ceph";
import { CEPH_INTEGRITY_NOTICE, cephCompletionNotice, CEPH_REFERENCE_NOTICE, generateCephDescriptiveResponse, presentCephMeasurements } from "@/lib/cephPresentation";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/** Legacy endpoint: descriptive observations only. Unvalidated geometric
 * template placement and external clinical generation are unavailable. */

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

  const study = await getCephStudy(id);
  if (!study) {
    return NextResponse.json({ message: "التحليل غير موجود أو مرفوض." }, { status: 404 });
  }
  if (!(await canAccessPatient(session, study.analysis.patientId, "canViewXrays"))) {
    return forbidden();
  }

  // A dimension/anchor template does not detect landmarks in the patient's image.
  // Reject legacy callers too; never save, relabel manual points or invent a fallback.
  if (body.action === "suggest-landmarks") {
    return NextResponse.json({
      ok: false, code: "UNVALIDATED_TEMPLATE", saved: false,
      message: "التحديد التلقائي غير متاح: الأداة السابقة قالب هندسي غير متحقق سريريًا، ولا تكشف المعالم من صورة الأشعة. حدّد المعالم يدويًا وراجعها.",
    }, { status: 409 });
  }

  // 2) قراءة وصفية محلية؛ يحرر الطبيب تشخيصه ويحفظه صراحةً في المسار المخصص
  if (body.action === "generate-diagnosis") {
    const completed = study.analysis.status === "completed";
    if (completed && study.provenance?.state === "integrity_unavailable") {
      return NextResponse.json({ok:false,code:"CEPH_INTEGRITY_UNAVAILABLE",message:CEPH_INTEGRITY_NOTICE}, {status:409});
    }
    const currentPoints: Partial<Record<LandmarkCode, Pt>> = {};
    for (const lm of completed ? [] : study.landmarks) {
      currentPoints[lm.code] = { x: lm.x, y: lm.y };
    }

    const results = presentCephMeasurements(completed ? [] : computeAll(currentPoints, study.analysis.mmPerPixel ?? NaN),
      completed ? study.measurements : null, study.provenance);
    const expert = generateCephDescriptiveResponse(results);

    // This endpoint is descriptive only. Legacy useAiChat/saveToDiagnosis flags
    // cannot bypass the clinical safety boundary or overwrite authored notes.
    const suggestion = {
      skeletal: expert.formatted.skeletal,
      dental: expert.formatted.dental,
      softTissue: expert.formatted.softTissue,
      finalDx: expert.formatted.finalDx,
      recommendationsText: expert.formatted.recommendationsText,
    };

    return NextResponse.json({
      ok: true,
      action: "generate-diagnosis",
      expertDiagnosis: expert,
      aiEnhancedText: null,
      savedToDiagnosis: false,
      notice: completed ? cephCompletionNotice(study.provenance) : CEPH_REFERENCE_NOTICE,
      clinicalMeaning: "raw_measurements_only_no_clinical_classification",
      recommendationMeaning: "no_automated_recommendation_not_a_contraindication",
      suggestion,
    });
  }

  return NextResponse.json({ message: "الإجراء action غير مدعوم." }, { status: 400 });
}

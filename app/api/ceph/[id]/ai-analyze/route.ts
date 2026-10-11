import { CEPH_SUGGESTION_ENGINE_VERSION, cephAcquisitionAge, type CephSuggestionProvenance } from "@/lib/ceph-suggestion-safety";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  getCephStudy, getPatient, getSettingsSafe,
} from "@/lib/db";
import {
  computeAll, generateCephExpertDiagnosis, suggestLandmarks,
  type LandmarkCode, type Pt,
} from "@/lib/ceph";
import { aiChat, getAiSettings } from "@/lib/ai";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/**
 * Existing draft-suggestion endpoint. Geometry is a review-only preview;
 * it does not detect anatomy or establish clinician review evidence.
 * Historical landmarks and approvals are not rewritten by this endpoint.
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

  const study = await getCephStudy(id);
  if (!study) {
    return NextResponse.json({ message: "التحليل غير موجود أو مرفوض." }, { status: 404 });
  }
  if (!(await canAccessPatient(session, study.analysis.patientId, "canViewXrays"))) {
    return forbidden();
  }

  const wantsSave = (body.action === "suggest-landmarks" && body.save)
    || (body.action === "generate-diagnosis" && body.saveToDiagnosis);
  if (wantsSave && !(await canAccessPatient(session, study.analysis.patientId, "canUploadXrays"))) {
    return forbidden();
  }
  if (body.action === "suggest-landmarks" && body.save) {
    return NextResponse.json({ message: "التوزيع الهندسي معاينة فقط؛ راجع كل موضع ثم احفظ النقطة يدويًا قبل استخدامها." }, { status: 409 });
  }
  if (body.action === "generate-diagnosis" && body.saveToDiagnosis) {
    return NextResponse.json({ message: "توليد الوصف معاينة فقط؛ راجع النص ثم احفظه من محرر التشخيص اليدوي." }, { status: 409 });
  }

  const provenance = (source: CephSuggestionProvenance["source"], age: number | undefined): CephSuggestionProvenance => ({
    analysisId: study.analysis.id, patientId: study.analysis.patientId, documentId: study.analysis.documentId,
    state: "draft", source, engineVersion: CEPH_SUGGESTION_ENGINE_VERSION,
    acquisitionAgeYears: age ?? null, agePrecision: age == null ? "unknown" : "birth-year-approximate",
    growthAssessment: "not-assessed",
  });
  const previewInputs = (value: NonNullable<Awaited<ReturnType<typeof getCephStudy>>>) => JSON.stringify({
    analysis: value.analysis,
    landmarks: [...value.landmarks].sort((a, b) => a.code.localeCompare(b.code)),
    measurements: value.measurements, diagnosis: value.diagnosis,
  });
  const patientInputs = (patient: Awaited<ReturnType<typeof getPatient>>) => JSON.stringify({ birthYear: patient?.birthYear ?? null, gender: patient?.gender ?? null });
  let patientSnapshot: string | null = null;
  // A preview may wait on patient/settings/provider reads. Recheck its current
  // principal, owner and read authority before releasing any clinical result.
  // No generation branch is permitted to mutate clinical facts.
  const previewRefusal = async () => {
    const current = await requireSession();
    if (!current) return denied();
    if (current.userId !== session.userId || current.username !== session.username
      || current.role !== session.role || current.credentialVersion !== session.credentialVersion) return forbidden();
    const latest = await getCephStudy(id);
    if (!latest || latest.analysis.patientId !== study.analysis.patientId
      || latest.analysis.documentId !== study.analysis.documentId || previewInputs(latest) !== previewInputs(study)) {
      return NextResponse.json({ message: "تغير سياق الدراسة؛ حدّثها قبل المحاولة." }, { status: 409 });
    }
    if (!(await canAccessPatient(current, latest.analysis.patientId, "canViewXrays"))) return forbidden();
    if (patientSnapshot !== null && patientInputs(await getPatient(latest.analysis.patientId)) !== patientSnapshot) {
      return NextResponse.json({ message: "تغيرت بيانات سياق المريض؛ حدّث الدراسة قبل المحاولة." }, { status: 409 });
    }
    return null;
  };

  // 1) خيار اقتراح المعالم الذكي
  if (body.action === "suggest-landmarks") {
    const currentPoints: Partial<Record<LandmarkCode, Pt>> = {};
    for (const lm of study.landmarks) {
      currentPoints[lm.code] = { x: lm.x, y: lm.y };
    }

    const width = body.imageWidth, height = body.imageHeight;
    if (typeof width !== "number" || typeof height !== "number"
      || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 100 || height < 100 || width > 16384 || height > 16384 || width * height > 64_000_000) {
      return NextResponse.json({ message: "أبعاد الصورة الأصلية مطلوبة كأعداد صحيحة موجبة ضمن الحد المدعوم؛ لا يُفترض حجم بديل." }, { status: 400 });
    }

    const patient = await getPatient(study.analysis.patientId);
    patientSnapshot = patientInputs(patient);
    const age = cephAcquisitionAge(patient?.birthYear, study.analysis.xrayDate);

    const suggestedMap = suggestLandmarks(width, height, currentPoints, { age, gender: patient?.gender });

    const suggestedPoints = (Object.entries(suggestedMap) as [LandmarkCode, Pt][]).map(([code, pt]) => ({
      code,
      x: pt.x,
      y: pt.y,
      // القاعدة الدستورية: المصدر دائمًا 'suggested'
      source: "suggested" as const,
    }));

    { const refusal = await previewRefusal(); if (refusal) return refusal; }
    return NextResponse.json({
      ok: true,
      action: "suggest-landmarks",
      landmarks: suggestedPoints,
      saved: false,
      provenance: provenance("geometric-placement", age),
      notice: "توزيع هندسي من الأبعاد والمعالم المتاحة، وليس رصدًا للمعالم من محتوى الصورة. راجع كل نقطة قبل اعتمادها.",
    });
  }

  // 2) خيار توليد التشخيص التقويمي الذكي وخطة العلاج
  if (body.action === "generate-diagnosis") {
    const patient = await getPatient(study.analysis.patientId);
    patientSnapshot = patientInputs(patient);

    const age = cephAcquisitionAge(patient?.birthYear, study.analysis.xrayDate);
    const gender = patient?.gender ?? undefined;

    const currentPoints: Partial<Record<LandmarkCode, Pt>> = {};
    for (const lm of study.landmarks) {
      currentPoints[lm.code] = { x: lm.x, y: lm.y };
    }

    const results = computeAll(currentPoints, study.analysis.mmPerPixel ?? NaN);
    const expert = generateCephExpertDiagnosis(results, { age, gender });

    let aiEnhancedText: string | null = null;
    /* (P2-11 — قرار المالك) وصف التحليل السيفالومتري نصٌّ سريري: لا يخرج إلى المزوّد
       الخارجي إلا بتفعيل `ai.clinical_external` صراحةً — وإلا فالتشخيص من المحرك المحلي. */
    const clinicalExternal = (await getSettingsSafe().catch(() => null))?.["ai.clinical_external"] === "true";
    const shouldTryAi = body.useAiChat === true && clinicalExternal;

    if (shouldTryAi) {
      try {
        const aiSettings = await getAiSettings();
        if (aiSettings.enabled && aiSettings.hasKey) {
          // Permission/source changes during awaited settings reads must prevent
          // transmission, not merely suppress the eventual provider response.
          if ((await getSettingsSafe().catch(() => null))?.["ai.clinical_external"] !== "true") {
            return NextResponse.json({ message: "تغير إذن الخدمة الخارجية؛ لم تُرسل البيانات." }, { status: 409 });
          }
          const refusal = await previewRefusal();
          if (refusal) return refusal;
          const clinicalContext = `التحليل السيفالومتري:
- التصنيف الهيكلي السهمي: ${expert.sagittalSkeletal.classification} (${expert.sagittalSkeletal.descriptionAr})
- النمط الهيكلي العمودي: ${expert.verticalSkeletal.pattern} (${expert.verticalSkeletal.growthTendencyAr})
- القواطع والتعويض: ${expert.dentalAnalysis.descriptionAr} — ${expert.dentalAnalysis.compensationAr}
- الأنسجة الرخوة والبروفايل: ${expert.aestheticProfile.summaryAr}
- العمر: ${age != null ? `${age} سنة` : "غير مسجل"} | الجنس: ${gender === "male" ? "ذكر" : gender === "female" ? "أنثى" : "غير محدد"}`;

          const res = await aiChat({
            messages: [
              {
                role: "system",
                content:
                  "لخص القياسات المعطاة فقط بالعربية في مسودة غير معتمدة لا تتجاوز 180 كلمة. احتفظ بالمجهول كما هو ولا تستنتج حالة النمو من العمر أو الصورة. لا توص بخطة علاج أو قلع أو أجهزة أو جراحة، ولا تدع اعتماد التشخيص أو المعالم أو المرجع. القرار والفحص والمراجعة للطبيب.",
              },
              { role: "user", content: clinicalContext },
            ],
            maxTokens: 500,
            temperature: 0.2,
          }, aiSettings);

          if (res.ok && res.content.trim()) {
            aiEnhancedText = res.content.trim();
          }
        }
      } catch {
        // Fallback to pure expert engine gracefully if AI is offline
      }
    }

    const suggestion = {
      skeletal: expert.formatted.skeletal,
      dental: expert.formatted.dental,
      softTissue: expert.formatted.softTissue,
      finalDx: expert.formatted.finalDx,
      recommendationsText: aiEnhancedText || expert.formatted.recommendationsText,
    };

    { const refusal = await previewRefusal(); if (refusal) return refusal; }
    return NextResponse.json({
      ok: true,
      action: "generate-diagnosis",
      expertDiagnosis: expert,
      aiEnhancedText,
      suggestion,
      provenance: provenance(aiEnhancedText ? "external-text-assistance" : "local-measurement-summary", age),
      externalTextStatus: aiEnhancedText ? "used" : shouldTryAi ? "unavailable" : "not-requested-or-disabled",
      notice: "مسودة تحتاج مراجعة الطبيب. لا تثبت تقييم النمو أو اعتماد التشخيص أو خطة العلاج.",
    });
  }

  return NextResponse.json({ message: "الإجراء action غير مدعوم." }, { status: 400 });
}

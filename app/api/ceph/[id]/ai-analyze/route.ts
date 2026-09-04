import { NextResponse } from "next/server";
import {
  getCephStudy, getPatient, updateCephDiagnosis, updateCephLandmarks,
} from "@/lib/db";
import {
  computeAll, generateCephExpertDiagnosis, suggestLandmarks,
  type LandmarkCode, type Pt,
} from "@/lib/ceph";
import { aiChat, getAiSettings } from "@/lib/ai";
import { requireSession } from "@/lib/session";

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
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح — مطلوب JSON." }, { status: 400 });
  }

  const study = await getCephStudy(id);
  if (!study) {
    return NextResponse.json({ message: "التحليل غير موجود أو مرفوض." }, { status: 404 });
  }

  // 1) خيار اقتراح المعالم الذكي
  if (body.action === "suggest-landmarks") {
    const currentPoints: Partial<Record<LandmarkCode, Pt>> = {};
    for (const lm of study.landmarks) {
      currentPoints[lm.code] = { x: lm.x, y: lm.y };
    }

    const width = Number(body.imageWidth) > 0 ? Number(body.imageWidth) : 1600;
    const height = Number(body.imageHeight) > 0 ? Number(body.imageHeight) : 1600;

    const suggestedMap = suggestLandmarks(width, height, currentPoints);

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

  // 2) خيار توليد التشخيص التقويمي الذكي وخطة العلاج
  if (body.action === "generate-diagnosis") {
    const patient = await getPatient(study.analysis.patientId);

    let age: number | undefined;
    if (patient?.birthYear) {
      const refYear = study.analysis.xrayDate
        ? new Date(study.analysis.xrayDate).getUTCFullYear()
        : new Date().getUTCFullYear();
      age = Math.max(0, refYear - patient.birthYear);
    }
    const gender = patient?.gender ?? undefined;

    const currentPoints: Partial<Record<LandmarkCode, Pt>> = {};
    for (const lm of study.landmarks) {
      currentPoints[lm.code] = { x: lm.x, y: lm.y };
    }

    const results = computeAll(currentPoints, study.analysis.mmPerPixel ?? NaN);
    const expert = generateCephExpertDiagnosis(results, { age, gender });

    let aiEnhancedText: string | null = null;
    const shouldTryAi = body.useAiChat !== false;

    if (shouldTryAi) {
      try {
        const aiSettings = await getAiSettings();
        if (aiSettings.enabled && aiSettings.hasKey) {
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
                  "أنت استشاري تقويم أسنان وخبير سيفالومتري في مركز عقلان. قدم ملخص تشخيصي تقويمي موجز وتوصيات خطة العلاج (القلع vs اللاقلاع، أجهزة تعديل النمو، التوسيع، الزرعات العظمية، أو الجراحة). التزم باللغة العربية الطبية الاحترافية واجعل الناتج لا يتجاوز 180 كلمة.",
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

    if (body.saveToDiagnosis && study.analysis.status === "draft") {
      await updateCephDiagnosis(
        id,
        {
          skeletal: suggestion.skeletal,
          dental: suggestion.dental,
          softTissue: suggestion.softTissue,
          finalDx: suggestion.finalDx,
          note: suggestion.recommendationsText,
        },
        session.username,
      );
    }

    return NextResponse.json({
      ok: true,
      action: "generate-diagnosis",
      expertDiagnosis: expert,
      aiEnhancedText,
      suggestion,
    });
  }

  return NextResponse.json({ message: "الإجراء action غير مدعوم." }, { status: 400 });
}

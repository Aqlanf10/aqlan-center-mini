import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getCephStudy } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

/** Legacy generation path: retained for scoped, explicit refusals to old clients. */

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

  // The retired template uses image dimensions, not image content. It must not
  // manufacture clinical points or overwrite manually recorded source labels.
  if (body.action === "suggest-landmarks") {
    return NextResponse.json({
      code: "manual_landmark_review_required",
      message: "التحديد الآلي للمعالم غير متاح. ضع المعالم وراجعها على الصورة يدوياً.",
    }, { status: 409 });
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

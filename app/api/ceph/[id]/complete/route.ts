import { NextResponse } from "next/server";
import { completeCephAnalysis, getCephStudy } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";
import {
  evaluateOrthoPermission,
  NO_STORE_HEADERS,
  orthoForbiddenResponse,
} from "@/lib/ortho-privacy-server";
import { validateCephClinicalApproval } from "@/lib/ortho-scientific-analyses";

export const dynamic = "force-dynamic";

/**
 * اعتماد التحليل السيفالومتري.
 *
 * هذا هو القرار السريري في الوحدة كلها — ولذلك هو مسارٌ وحده:
 * 1. التحقق من صلاحية «اعتماد القياسات» وقسم السيفالومتري عبر سياسة الخصوصية.
 * 2. التحقق العلمي الصارم: المعايرة المليمترية + حد أدنى 24 معلمًا تشريحيًا مؤكدًا من الطبيب + اكتمال المعالم الأساسية.
 * 3. لا اقتراح حاسوبي يُعتمد تلقائيًا؛ الاعتماد طلب صريح بيد الطبيب.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const { id: raw } = await context.params;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم التحليل غير صالح." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const study = await getCephStudy(id);
  if (!study) {
    return NextResponse.json({ message: "التحليل غير موجود." }, { status: 404, headers: NO_STORE_HEADERS });
  }
  if (!(await canAccessPatient(session, study.analysis.patientId, "canUploadXrays"))) {
    return NextResponse.json({ message: "غير مصرّح لك باعتماد هذا التحليل." }, { status: 403, headers: NO_STORE_HEADERS });
  }

  const orthoAccess = await evaluateOrthoPermission(
    session,
    { permission: "measurements.approve", section: "ceph" },
    { patientId: study.analysis.patientId },
  );
  if (!orthoAccess.allowed) {
    return orthoForbiddenResponse("اعتماد التحليل السيفالومتري يتطلب صلاحية «اعتماد القياسات».", {
      reason: orthoAccess.reason,
    });
  }

  // Scientific 24-landmark + calibration clinical gate
  const gate = validateCephClinicalApproval({
    mmPerPixel: study.analysis.mmPerPixel,
    landmarks: study.landmarks,
  });
  if (!gate.ok) {
    return NextResponse.json(
      {
        message: gate.errorsAr.join(" "),
        errors: gate.errorsAr,
        confirmedCount: gate.confirmedCount,
        requiredMin: gate.requiredMin,
        missingRequiredCodes: gate.missingRequiredCodes,
      },
      { status: 409, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const done = await completeCephAnalysis(id, session.username);
    if (!done.ok) {
      return NextResponse.json({ message: done.message ?? "لا يمكن الاعتماد." }, { status: 409, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(
      {
        ok: true,
        measurements: done.measurements,
        summary: done.summary,
        confirmedLandmarks: gate.confirmedCount,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر اعتماد التحليل." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}

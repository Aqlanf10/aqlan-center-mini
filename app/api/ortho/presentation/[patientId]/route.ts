import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  evaluateOrthoPermission,
  NO_STORE_HEADERS,
  orthoForbiddenResponse,
} from "@/lib/ortho-privacy-server";
import { loadOrthoWorkspaceRecord, filterWorkspaceByPrivacy } from "@/lib/ortho-workspace-store";
import {
  buildCasePresentationDeck,
  generateEditablePptxBytes,
} from "@/lib/ortho-case-presentation";
import {
  CLINIC_TIME_ZONE,
  getPatient,
  getSettingsSafe,
  listPatientOrthoCases,
  recordAudit,
} from "@/lib/db";
import { clinicDateString } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ patientId: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });
  }

  const { patientId: rawId } = await context.params;
  const patientId = Number(rawId);
  if (!Number.isSafeInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "معرّف المريض غير صالح." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  let body: {
    format?: "pptx" | "pdf";
    anonymize?: boolean;
    selectedSlideIds?: string[];
  };
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    const errRes = bodyErrorResponse(err);
    if (errRes) return errRes;
    return NextResponse.json({ message: "بيانات الطلب غير صالحة." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const format = body.format === "pdf" ? "pdf" : "pptx";
  const anonymize = body.anonymize === true;

  const evalCreate = await evaluateOrthoPermission(
    session,
    { permission: "presentation.create", section: "reports" },
    { patientId },
  );
  if (!evalCreate.allowed || !evalCreate.access) {
    return orthoForbiddenResponse("إنشاء Case Presentation يتطلب صلاحية «إنشاء Case Presentation».", {
      reason: evalCreate.reason,
    });
  }

  const actionPerm = format === "pptx" ? "reports.export" : "reports.print";
  if (!evalCreate.access.permissions[actionPerm]) {
    return orthoForbiddenResponse(
      format === "pptx"
        ? "تصدير ملفات PPTX يتطلب صلاحية «تصدير التقارير»."
        : "طباعة العرض كـ PDF تتطلب صلاحية «طباعة التقارير».",
    );
  }

  const patient = await getPatient(patientId).catch(() => null);
  if (!patient) {
    return NextResponse.json({ message: "ملف المريض غير موجود." }, { status: 404, headers: NO_STORE_HEADERS });
  }

  const rawRecord = await loadOrthoWorkspaceRecord(patientId);
  const { filtered } = filterWorkspaceByPrivacy(rawRecord, evalCreate.access);

  // Educational anonymization consent guard
  if (anonymize && !filtered.questionnaire.consentForEducationDeidentified && !evalCreate.subject?.isOwner) {
    return NextResponse.json(
      {
        message:
          "التصدير التعليمي مُخفى الهوية يتطلب توثيق موافقة المريض الخطية في تبويب «الاستبيان» أولًا.",
      },
      { status: 409, headers: NO_STORE_HEADERS },
    );
  }

  const settings = await getSettingsSafe().catch(() => null);
  const clinicName = settings?.["clinic.name"]?.trim() || "مركز الدكتور عقلان";
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  const cases = await listPatientOrthoCases(patientId, today).catch(() => []);
  const sessionSummaries = cases.flatMap((c) =>
    (c.adjustments ?? []).map((a) => ({
      date: a.doneOn,
      upperWire: a.upperWire,
      lowerWire: a.lowerWire,
      note: a.done,
    })),
  );

  const deck = buildCasePresentationDeck({
    clinicName,
    patientName: patient.fullName,
    patientCode: patient.patientNumber,
    record: filtered,
    selectedSlideIds: Array.isArray(body.selectedSlideIds) ? body.selectedSlideIds : undefined,
    anonymize,
    sessionSummaries,
    photoCount: 0,
  });

  await recordAudit({
    action: "ortho.presentation_export",
    entity: "patient",
    entityId: String(patientId),
    entityLabel: anonymize ? `عرض تعليمي مخفى الهوية #${patientId}` : patient.fullName,
    details: {
      الصيغة: format.toUpperCase(),
      إخفاء_الهوية: anonymize,
      عدد_الشرائح: deck.slides.length,
    },
    actor: session.username,
    actorRole: session.role,
  }).catch(() => {});

  if (format === "pptx") {
    const pptxBytes = generateEditablePptxBytes(deck);
    const filename = anonymize
      ? `AQLAN-Ortho-Case-EDU-${patientId}.pptx`
      : `AQLAN-Ortho-Case-${patient.patientNumber || patientId}.pptx`;
    return new NextResponse(Buffer.from(pptxBytes), {
      status: 200,
      headers: {
        ...NO_STORE_HEADERS,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json({ ok: true, deck }, { status: 200, headers: NO_STORE_HEADERS });
}

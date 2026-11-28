import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  evaluateOrthoPermission,
  NO_STORE_HEADERS,
  orthoForbiddenResponse,
} from "@/lib/ortho-privacy-server";
import {
  filterWorkspaceByPrivacy,
  loadOrthoWorkspaceRecord,
  orthoWorkspaceCaseBelongsToPatient,
  saveOrthoWorkspaceRecord,
} from "@/lib/ortho-workspace-store";
import type { OrthoWorkspaceRecord } from "@/lib/ortho-workspace-types";
import { recordAudit } from "@/lib/db";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

function parsePatientId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const invalidCase = () => NextResponse.json({ message: "معرّف حالة التقويم غير صالح." }, { status: 400, headers: NO_STORE_HEADERS });
const missingCase = () => NextResponse.json({ message: "حالة التقويم غير موجودة لهذا المريض." }, { status: 404, headers: NO_STORE_HEADERS });

function scopeOf(request: NextRequest): number | null | undefined {
  const values = new URL(request.url).searchParams.getAll("orthoCaseId");
  if (values.length === 0) return null;
  return values.length === 1 && /^[1-9][0-9]*$/.test(values[0])
    ? parsePatientId(values[0]) ?? undefined
    : undefined;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ patientId: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });
  }
  const { patientId: rawId } = await context.params;
  const patientId = parsePatientId(rawId);
  if (!patientId) {
    return NextResponse.json({ message: "معرّف المريض غير صالح." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return orthoForbiddenResponse("غير مصرّح لك بالوصول إلى ملف هذا المريض.");
  }

  const orthoCaseId = scopeOf(req);
  if (orthoCaseId === undefined) return invalidCase();
  const evalRes = await evaluateOrthoPermission(
    session,
    { permission: "records.read" },
    { patientId, orthoCaseId },
  );
  if (!evalRes.allowed || !evalRes.access) {
    await recordAudit({
      action: "ortho.access_denied",
      entity: "patient",
      entityId: String(patientId),
      entityLabel: `ملف تقويم مريض #${patientId}`,
      details: { المسار: "GET /api/ortho/workspace/[patientId]", السبب: evalRes.reason },
      actor: session.username,
      actorRole: session.role,
    }).catch(() => {});
    return orthoForbiddenResponse("غير مصرّح لك باستعراض مساحة عمل التقويم لهذا المريض.", {
      reason: evalRes.reason,
    });
  }

  if (orthoCaseId !== null && !await orthoWorkspaceCaseBelongsToPatient(patientId, orthoCaseId)) return missingCase();
  const record = await loadOrthoWorkspaceRecord(patientId, orthoCaseId);
  const { filtered, hiddenSections } = filterWorkspaceByPrivacy(record, evalRes.access);

  return NextResponse.json(
    {
      workspace: filtered,
      hiddenSections,
      access: {
        moduleVisible: evalRes.access.moduleVisible,
        permissions: evalRes.access.permissions,
        sections: evalRes.access.sections,
        fields: evalRes.access.fields,
      },
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

export async function PUT(
  req: NextRequest,
  context: { params: Promise<{ patientId: string }> },
) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE_HEADERS });
  }
  const { patientId: rawId } = await context.params;
  const patientId = parsePatientId(rawId);
  if (!patientId) {
    return NextResponse.json({ message: "معرّف المريض غير صالح." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (!(await canAccessPatient(session, patientId))) {
    return orthoForbiddenResponse("غير مصرّح لك بتعديل ملف هذا المريض.");
  }

  const orthoCaseId = scopeOf(req);
  if (orthoCaseId === undefined) return invalidCase();

  let parsedBody: { workspace?: Partial<OrthoWorkspaceRecord>; expectedRevision?: number };
  try {
    parsedBody = await readJsonBody<{
      workspace?: Partial<OrthoWorkspaceRecord>;
      expectedRevision?: number;
    }>(req, 512 * 1024);
  } catch (err) {
    const errRes = bodyErrorResponse(err);
    if (errRes) return errRes;
    return NextResponse.json({ message: "تعذّر قراءة بيانات الطلب." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const incoming = parsedBody?.workspace;
  if (!incoming || typeof incoming !== "object") {
    return NextResponse.json({ message: "بيانات مساحة العمل غير صالحة." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  if (incoming.orthoCaseId !== undefined && incoming.orthoCaseId !== orthoCaseId) return invalidCase();

  const evalRes = await evaluateOrthoPermission(
    session,
    { anyOfPermissions: ["records.edit", "records.blind_create"] },
    { patientId, orthoCaseId },
  );
  if (!evalRes.allowed || !evalRes.access) {
    await recordAudit({
      action: "ortho.access_denied",
      entity: "patient",
      entityId: String(patientId),
      entityLabel: `ملف تقويم مريض #${patientId}`,
      details: { المسار: "PUT /api/ortho/workspace/[patientId]", السبب: evalRes.reason },
      actor: session.username,
      actorRole: session.role,
    }).catch(() => {});
    return orthoForbiddenResponse("غير مصرّح لك بتعديل أو إدخال بيانات مساحة عمل التقويم.", {
      reason: evalRes.reason,
    });
  }

  if (orthoCaseId !== null && !await orthoWorkspaceCaseBelongsToPatient(patientId, orthoCaseId)) return missingCase();
  const current = await loadOrthoWorkspaceRecord(patientId, orthoCaseId);
  const perms = evalRes.access.permissions;

  // Enforce approval-specific permissions server-side
  const newApprovedAnalyses = Array.isArray(incoming.approvedAnalyses) ? incoming.approvedAnalyses : null;
  if (
    newApprovedAnalyses &&
    newApprovedAnalyses.length > current.approvedAnalyses.length &&
    !perms["measurements.approve"]
  ) {
    return orthoForbiddenResponse("اعتماد القياسات والتحليلات يتطلب صلاحية «اعتماد القياسات».");
  }

  if (
    incoming.diagnosisSummary?.approvedAt &&
    incoming.diagnosisSummary.approvedAt !== current.diagnosisSummary.approvedAt &&
    !perms["diagnosis.approve"]
  ) {
    return orthoForbiddenResponse("اعتماد التشخيص يتطلب صلاحية «اعتماد التشخيص».");
  }

  if (
    incoming.treatmentPlan?.approvedAt &&
    incoming.treatmentPlan.approvedAt !== current.treatmentPlan.approvedAt &&
    !perms["plan.approve"]
  ) {
    return orthoForbiddenResponse("اعتماد خطة العلاج يتطلب صلاحية «اعتماد خطة العلاج».");
  }

  // Re-open guard: modifying already-approved diagnosis/plan requires records.reopen
  if (
    current.diagnosisSummary.approvedAt &&
    incoming.diagnosisSummary &&
    incoming.diagnosisSummary.finalDiagnosisAr !== current.diagnosisSummary.finalDiagnosisAr &&
    !perms["records.reopen"]
  ) {
    return orthoForbiddenResponse("التشخيص معتمد بالفعل؛ إعادة فتحه تتطلب صلاحية «إعادة فتح السجلات المعتمدة».");
  }

  if (
    current.treatmentPlan.approvedAt &&
    incoming.treatmentPlan &&
    incoming.treatmentPlan.mechanicsSummary !== current.treatmentPlan.mechanicsSummary &&
    !perms["records.reopen"]
  ) {
    return orthoForbiddenResponse("خطة العلاج معتمدة بالفعل؛ إعادة فتحها تتطلب صلاحية «إعادة فتح السجلات المعتمدة».");
  }

  // Blind-create protection: prevent users without records.read from wiping existing unseen sections
  const sanitizedIncoming: Partial<OrthoWorkspaceRecord> = { ...incoming };
  if (!perms["records.read"]) {
    delete sanitizedIncoming.approvedAnalyses;
    delete sanitizedIncoming.diagnosisSummary;
    delete sanitizedIncoming.treatmentPlan;
    delete sanitizedIncoming.retention;
    delete sanitizedIncoming.orthoCoreCase;
  } else if (sanitizedIncoming.orthoCoreCase && typeof sanitizedIncoming.orthoCoreCase === "object"
    && (!perms["photos.view"] || !perms["photos.edit"] || !evalRes.access.fields.previousPhotos || !evalRes.access.sections.media)) {
    const previous = current.orthoCoreCase as Record<string, unknown> | undefined;
    sanitizedIncoming.orthoCoreCase = {
      ...sanitizedIncoming.orthoCoreCase,
      media: previous?.media,
    };
  }

  const saved = await saveOrthoWorkspaceRecord(
    patientId,
    sanitizedIncoming,
    session.username,
    parsedBody?.expectedRevision,
    { orthoCaseId, actorRole: session.role, blindCreate: !perms["records.read"] },
  );
  if (!saved.ok) {
    return NextResponse.json(
      { message: saved.message, currentRevision: saved.currentRevision },
      { status: saved.status, headers: NO_STORE_HEADERS },
    );
  }

  await recordAudit({
    action: "ortho.workspace_update",
    entity: "patient",
    entityId: String(patientId),
    entityLabel: `ملف تقويم مريض #${patientId}`,
    details: { رقم_الإصدار: saved.record.revision, إدخال_أعمى: !perms["records.read"] },
    actor: session.username,
    actorRole: session.role,
  }).catch(() => {});

  if (!perms["records.read"]) {
    return NextResponse.json(
      { ok: true, blindReceipt: true, revision: saved.record.revision },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  const { filtered } = filterWorkspaceByPrivacy(saved.record, evalRes.access);
  return NextResponse.json(
    { ok: true, workspace: filtered },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

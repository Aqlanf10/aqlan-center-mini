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
  saveOrthoWorkspaceRecord,
  type OrthoWorkspaceCommandType,
} from "@/lib/ortho-workspace-store";
import type { OrthoWorkspaceRecord } from "@/lib/ortho-workspace-types";
import type { OrthoPermissionKey, OrthoSectionKey } from "@/lib/ortho-privacy";
import { recordAudit } from "@/lib/db";

export const dynamic = "force-dynamic";

const ALLOWED_COMMANDS = new Set<OrthoWorkspaceCommandType>([
  "save_questionnaire",
  "save_exam",
  "save_analysis_draft",
  "approve_analysis",
  "save_diagnosis_draft",
  "approve_diagnosis",
  "save_plan_draft",
  "approve_plan",
  "reopen_approved",
  "save_retention",
  "save_presentation",
  "save_orthocore_draft",
  "save_workspace",
]);

const COMMAND_REQUIREMENTS: Record<
  OrthoWorkspaceCommandType,
  { permissions: readonly OrthoPermissionKey[]; section?: OrthoSectionKey; allowedInBlindCreate?: boolean }
> = {
  save_questionnaire: { permissions: ["records.edit", "records.create", "records.blind_create"], section: "medical_history", allowedInBlindCreate: true },
  save_exam: { permissions: ["records.edit", "records.create", "records.blind_create"], section: "exam", allowedInBlindCreate: true },
  save_analysis_draft: { permissions: ["measurements.perform", "measurements.edit", "records.edit"], section: "measurements" },
  approve_analysis: { permissions: ["measurements.approve"], section: "measurements" },
  save_diagnosis_draft: { permissions: ["records.edit", "records.create"], section: "diagnosis" },
  approve_diagnosis: { permissions: ["diagnosis.approve"], section: "diagnosis" },
  save_plan_draft: { permissions: ["records.edit", "records.create"], section: "plan" },
  approve_plan: { permissions: ["plan.approve"], section: "plan" },
  reopen_approved: { permissions: ["records.reopen"] },
  save_retention: { permissions: ["records.edit", "sessions.record"], section: "retention" },
  save_presentation: { permissions: ["presentation.create", "records.edit"], section: "reports" },
  save_orthocore_draft: { permissions: ["records.edit", "records.create", "records.blind_create"], allowedInBlindCreate: true },
  save_workspace: { permissions: ["records.edit", "records.create", "records.blind_create"], allowedInBlindCreate: true },
};

function parsePositiveInt(raw: string | null | undefined): number | null {
  if (!raw || !/^[1-9]\d*$/.test(String(raw))) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
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
  const patientId = parsePositiveInt(rawId);
  if (!patientId) {
    return NextResponse.json({ message: "معرّف المريض غير صالح." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  const orthoCaseId = parsePositiveInt(new URL(req.url).searchParams.get("orthoCaseId"));

  const evalRes = await evaluateOrthoPermission(
    session,
    { anyOfPermissions: ["records.read", "records.blind_create"] },
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
    });
    return orthoForbiddenResponse("غير مصرّح لك باستعراض مساحة عمل التقويم لهذا المريض.", {
      reason: evalRes.reason,
    });
  }

  const record = await loadOrthoWorkspaceRecord(patientId, orthoCaseId);
  const { filtered, hiddenSections } = filterWorkspaceByPrivacy(record, evalRes.access);

  // Blind-create callers get the current revision number so CAS works, with zero prior clinical content!
  if (!evalRes.access.permissions["records.read"]) {
    return NextResponse.json(
      {
        workspace: { ...filtered, revision: record.revision },
        blindMode: true,
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
  const patientId = parsePositiveInt(rawId);
  if (!patientId) {
    return NextResponse.json({ message: "معرّف المريض غير صالح." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  let parsedBody: {
    command?: OrthoWorkspaceCommandType;
    orthoCaseId?: number | null;
    reason?: string;
    workspace?: Partial<OrthoWorkspaceRecord>;
    expectedRevision?: number;
  };
  try {
    parsedBody = await readJsonBody(req, 512 * 1024);
  } catch (err) {
    const errRes = bodyErrorResponse(err);
    if (errRes) return errRes;
    return NextResponse.json({ message: "تعذّر قراءة بيانات الطلب." }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const command: OrthoWorkspaceCommandType =
    parsedBody?.command && ALLOWED_COMMANDS.has(parsedBody.command) ? parsedBody.command : "save_workspace";
  const incoming = parsedBody?.workspace ?? (command === "reopen_approved" ? {} : null);
  if (!incoming || typeof incoming !== "object") {
    return NextResponse.json({ message: "بيانات مساحة العمل غير صالحة." }, { status: 400, headers: NO_STORE_HEADERS });
  }
  if (typeof parsedBody?.expectedRevision !== "number" || !Number.isInteger(parsedBody.expectedRevision) || parsedBody.expectedRevision < 0) {
    return NextResponse.json(
      { code: "REVISION_REQUIRED", message: "رقم الإصدار الحالي (expectedRevision) مطلوب لمنع تعارض الكتابة المتزامنة." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const queryCaseId = parsePositiveInt(new URL(req.url).searchParams.get("orthoCaseId"));
  const bodyCaseId =
    typeof parsedBody.orthoCaseId === "number" && parsedBody.orthoCaseId > 0
      ? parsedBody.orthoCaseId
      : typeof incoming.orthoCaseId === "number" && incoming.orthoCaseId > 0
        ? incoming.orthoCaseId
        : null;
  const orthoCaseId = bodyCaseId ?? queryCaseId;

  const cmdSpec = COMMAND_REQUIREMENTS[command];
  const evalRes = await evaluateOrthoPermission(
    session,
    { anyOfPermissions: cmdSpec.permissions, section: cmdSpec.section },
    { patientId, orthoCaseId },
  );
  if (!evalRes.allowed || !evalRes.access) {
    await recordAudit({
      action: "ortho.access_denied",
      entity: "patient",
      entityId: String(patientId),
      entityLabel: `ملف تقويم مريض #${patientId}`,
      details: { المسار: "PUT /api/ortho/workspace/[patientId]", الأمر: command, السبب: evalRes.reason },
      actor: session.username,
      actorRole: session.role,
    });
    return orthoForbiddenResponse("غير مصرّح لك بتعديل أو اعتماد هذا القسم في وحدة التقويم.", {
      reason: evalRes.reason,
    });
  }

  const perms = evalRes.access.permissions;
  const isBlindCreate = !perms["records.read"] && perms["records.blind_create"];
  if (isBlindCreate && !cmdSpec.allowedInBlindCreate) {
    return orthoForbiddenResponse("وضع الإدخال الأعمى يقتصر على إدخال البيانات الأولية دون تعديل أو اعتماد السجلات السابقة.");
  }

  if (command === "reopen_approved" && (!parsedBody.reason || parsedBody.reason.trim().length < 3)) {
    return NextResponse.json(
      { message: "إعادة فتح السجل السريري المعتمد تتطلب كتابة سبب واضح للتدقيق." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const current = await loadOrthoWorkspaceRecord(patientId, orthoCaseId);

  // Enforce approval-specific permissions server-side even on composite workspace saves
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

  if (
    command !== "reopen_approved" &&
    current.diagnosisSummary.approvedAt &&
    incoming.diagnosisSummary &&
    incoming.diagnosisSummary.finalDiagnosisAr !== current.diagnosisSummary.finalDiagnosisAr &&
    !perms["records.reopen"]
  ) {
    return orthoForbiddenResponse("التشخيص معتمد بالفعل؛ إعادة فتحه تتطلب صلاحية «إعادة فتح السجلات المعتمدة».");
  }

  if (
    command !== "reopen_approved" &&
    current.treatmentPlan.approvedAt &&
    incoming.treatmentPlan &&
    incoming.treatmentPlan.mechanicsSummary !== current.treatmentPlan.mechanicsSummary &&
    !perms["records.reopen"]
  ) {
    return orthoForbiddenResponse("خطة العلاج معتمدة بالفعل؛ إعادة فتحها تتطلب صلاحية «إعادة فتح السجلات المعتمدة».");
  }

  // Blind-create protection: preserve all unseen approved/clinical sections untouched
  const sanitizedIncoming: Partial<OrthoWorkspaceRecord> = { ...incoming };
  if (isBlindCreate) {
    delete sanitizedIncoming.approvedAnalyses;
    delete sanitizedIncoming.diagnosisSummary;
    delete sanitizedIncoming.treatmentPlan;
    delete sanitizedIncoming.retention;
    delete sanitizedIncoming.presentation;
    delete sanitizedIncoming.orthoCoreCase;
  }

  const saved = await saveOrthoWorkspaceRecord(
    patientId,
    sanitizedIncoming,
    session.username,
    parsedBody.expectedRevision,
    {
      orthoCaseId,
      actorRole: session.role,
      command,
      reason: parsedBody.reason?.trim(),
      blindCreate: isBlindCreate,
    },
  );
  if (!saved.ok) {
    return NextResponse.json(
      { code: saved.code, message: saved.message, currentRevision: saved.currentRevision },
      { status: saved.status, headers: NO_STORE_HEADERS },
    );
  }

  if (isBlindCreate) {
    return NextResponse.json(
      { ok: true, blindReceipt: true, revision: saved.record.revision },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  }

  const { filtered } = filterWorkspaceByPrivacy(saved.record, evalRes.access);
  return NextResponse.json(
    { ok: true, revision: saved.record.revision, workspace: filtered },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}

import * as db from "./db";
import {
  createDefaultOrthoWorkspace,
  type OrthoWorkspaceRecord,
} from "./ortho-workspace-types";
import type { OrthoSectionKey, ResolvedOrthoAccess } from "./ortho-privacy";

export function workspaceStorageKey(patientId: number): string {
  return `ortho.workspace.v1.p.${patientId}`;
}

function mergeRecord(patientId: number, raw: unknown): OrthoWorkspaceRecord {
  const base = createDefaultOrthoWorkspace(patientId);
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<OrthoWorkspaceRecord>;
  return {
    ...base,
    ...obj,
    schemaVersion: 1,
    patientId,
    orthoCaseId: typeof obj.orthoCaseId === "number" ? obj.orthoCaseId : null,
    revision: typeof obj.revision === "number" && Number.isInteger(obj.revision) ? obj.revision : 0,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : null,
    updatedBy: typeof obj.updatedBy === "string" ? obj.updatedBy : null,
    questionnaire: {
      ...base.questionnaire,
      ...(obj.questionnaire ?? {}),
      habits: { ...base.questionnaire.habits, ...(obj.questionnaire?.habits ?? {}) },
      tmjSymptoms: { ...base.questionnaire.tmjSymptoms, ...(obj.questionnaire?.tmjSymptoms ?? {}) },
    },
    clinicalExam: {
      ...base.clinicalExam,
      ...(obj.clinicalExam ?? {}),
      extraoral: { ...base.clinicalExam.extraoral, ...(obj.clinicalExam?.extraoral ?? {}) },
      intraoral: { ...base.clinicalExam.intraoral, ...(obj.clinicalExam?.intraoral ?? {}) },
      teeth: obj.clinicalExam?.teeth && typeof obj.clinicalExam.teeth === "object" ? obj.clinicalExam.teeth : {},
    },
    facialPhoto: { ...base.facialPhoto, ...(obj.facialPhoto ?? {}) },
    model3d: { ...base.model3d, ...(obj.model3d ?? {}) },
    cbct: { ...base.cbct, ...(obj.cbct ?? {}) },
    castInputs: { ...base.castInputs, ...(obj.castInputs ?? {}) },
    approvedAnalyses: Array.isArray(obj.approvedAnalyses) ? obj.approvedAnalyses : [],
    problems: Array.isArray(obj.problems) ? obj.problems : [],
    diagnosisSummary: { ...base.diagnosisSummary, ...(obj.diagnosisSummary ?? {}) },
    treatmentPlan: {
      ...base.treatmentPlan,
      ...(obj.treatmentPlan ?? {}),
      primaryGoals: Array.isArray(obj.treatmentPlan?.primaryGoals) ? obj.treatmentPlan.primaryGoals : [],
      extractionTeethFdi: Array.isArray(obj.treatmentPlan?.extractionTeethFdi) ? obj.treatmentPlan.extractionTeethFdi : [],
      phaseBreakdown: Array.isArray(obj.treatmentPlan?.phaseBreakdown) ? obj.treatmentPlan.phaseBreakdown : [],
    },
    retention: {
      ...base.retention,
      ...(obj.retention ?? {}),
      followups: Array.isArray(obj.retention?.followups) ? obj.retention.followups : [],
    },
    presentation: {
      ...base.presentation,
      ...(obj.presentation ?? {}),
      selectedSlideIds: Array.isArray(obj.presentation?.selectedSlideIds)
        ? obj.presentation.selectedSlideIds
        : base.presentation.selectedSlideIds,
    },
  };
}

/**
 * Strips any workspace sections or sensitive fields that the user is not
 * permitted to view according to the Owner's granular OrthoPrivacyPolicy.
 */
export function filterWorkspaceByPrivacy(
  record: OrthoWorkspaceRecord,
  access: ResolvedOrthoAccess,
): { filtered: OrthoWorkspaceRecord; hiddenSections: OrthoSectionKey[] } {
  const blank = createDefaultOrthoWorkspace(record.patientId, record.orthoCaseId);
  const hiddenSections: OrthoSectionKey[] = [];
  const next: OrthoWorkspaceRecord = { ...record };

  if (!access.sections.medical_history || !access.fields.medicalHistory) {
    hiddenSections.push("medical_history");
    next.questionnaire = {
      ...blank.questionnaire,
      chiefComplaint: access.sections.medical_history ? record.questionnaire.chiefComplaint : "",
    };
  }
  if (!access.sections.exam) {
    hiddenSections.push("exam");
    next.clinicalExam = blank.clinicalExam;
  }
  if (!access.sections.photo_analysis) {
    hiddenSections.push("photo_analysis");
    next.facialPhoto = blank.facialPhoto;
  }
  if (!access.sections.model3d) {
    hiddenSections.push("model3d");
    next.model3d = blank.model3d;
  }
  if (!access.sections.media) {
    hiddenSections.push("media");
    next.cbct = blank.cbct;
  }
  if (!access.sections.measurements) {
    hiddenSections.push("measurements");
    next.castInputs = blank.castInputs;
    next.approvedAnalyses = [];
  }
  if (!access.sections.diagnosis) {
    hiddenSections.push("diagnosis");
    next.problems = [];
    next.diagnosisSummary = blank.diagnosisSummary;
  }
  if (!access.sections.plan && !access.sections.appliances) {
    hiddenSections.push("plan");
    next.treatmentPlan = blank.treatmentPlan;
  }
  if (!access.sections.retention) {
    hiddenSections.push("retention");
    next.retention = blank.retention;
  }
  if (!access.sections.reports) {
    hiddenSections.push("reports");
    next.presentation = blank.presentation;
  }
  if (!access.fields.clinicalNotes) {
    next.clinicalExam = {
      ...next.clinicalExam,
      extraoral: { ...next.clinicalExam.extraoral, notes: "" },
      intraoral: { ...next.clinicalExam.intraoral, notes: "" },
    };
    next.model3d = { ...next.model3d, notes: "" };
    next.cbct = { ...next.cbct, airwayNotes: "", impactionNotes: "", rootResorptionNotes: "" };
  }
  if (!access.fields.internalNotes) {
    next.presentation = { ...next.presentation, presenterNotes: "" };
  }

  // Also enforce granular section/field stripping inside orthoCoreCase snapshot
  if (next.orthoCoreCase && typeof next.orthoCoreCase === "object") {
    const oc = { ...(next.orthoCoreCase as Record<string, unknown>) };
    if (!access.sections.medical_history || !access.fields.medicalHistory) delete oc.questionnaire;
    if (!access.sections.exam) delete oc.clinicalExam;
    if (!access.sections.media || !access.permissions["photos.view"] || !access.fields.previousPhotos) {
      oc.media = [];
    }
    if (!access.sections.measurements) oc.analyses = [];
    if (!access.sections.diagnosis) {
      oc.problems = [];
      delete oc.diagnosis;
    }
    if (!access.sections.plan && !access.sections.appliances) delete oc.treatmentPlan;
    if (!access.sections.sessions) oc.sessions = [];
    if (!access.sections.retention) delete oc.retention;
    if (!access.sections.reports) oc.customReports = [];
    next.orthoCoreCase = oc;
  }

  return { filtered: next, hiddenSections };
}

export async function loadOrthoWorkspaceRecord(patientId: number): Promise<OrthoWorkspaceRecord> {
  if (typeof db.ensureSchema === "function") await db.ensureSchema();
  const pool = typeof db.getPool === "function" ? db.getPool() : null;
  if (!pool) return createDefaultOrthoWorkspace(patientId);
  const { rows } = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = $1",
    [workspaceStorageKey(patientId)],
  );
  if (!rows[0]?.value) return createDefaultOrthoWorkspace(patientId);
  try {
    return mergeRecord(patientId, JSON.parse(rows[0].value));
  } catch {
    return createDefaultOrthoWorkspace(patientId);
  }
}

export async function saveOrthoWorkspaceRecord(
  patientId: number,
  incoming: Partial<OrthoWorkspaceRecord>,
  actorUsername: string,
  expectedRevision?: number,
): Promise<
  | { ok: true; record: OrthoWorkspaceRecord }
  | { ok: false; status: number; message: string; currentRevision?: number }
> {
  if (typeof db.ensureSchema === "function") await db.ensureSchema();
  const pool = typeof db.getPool === "function" ? db.getPool() : null;
  if (!pool) {
    return { ok: false, status: 503, message: "قاعدة البيانات غير متاحة." };
  }
  const existing = await loadOrthoWorkspaceRecord(patientId);
  if (
    typeof expectedRevision === "number" &&
    Number.isInteger(expectedRevision) &&
    expectedRevision !== existing.revision
  ) {
    return {
      ok: false,
      status: 409,
      message: "تم تعديل ملف التقويم من مستخدم آخر. حدّث الصفحة قبل الحفظ.",
      currentRevision: existing.revision,
    };
  }

  const next = mergeRecord(patientId, {
    ...existing,
    ...incoming,
    patientId,
    revision: existing.revision + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: actorUsername,
  });

  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [workspaceStorageKey(patientId), JSON.stringify(next)],
  );

  return { ok: true, record: next };
}

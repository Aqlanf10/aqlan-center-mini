import * as db from "./db";
import type { DbClient } from "./db";
import { withIsolation } from "./transactions";
import {
  createDefaultOrthoWorkspace,
  type OrthoWorkspaceRecord,
} from "./ortho-workspace-types";
import type { OrthoSectionKey, ResolvedOrthoAccess } from "./ortho-privacy";

/**
 * Case-Scoped, Atomic CAS Orthodontic Clinical Workspace Store (Charter §9, TD-04..TD-06):
 *
 * 1. Scopes every workspace record by `(patientId, orthoCaseId)` (`scopeKey = case:${orthoCaseId}` or `intake`),
 *    preventing data mixing when a patient has multiple orthodontic cases (e.g., Phase I mixed dentition + Phase II fixed).
 * 2. Uses normalized PostgreSQL tables (`ortho_clinical_workspaces` + `ortho_clinical_workspace_revisions` from
 *    `migrations/proposals/0140_ortho_clinical_workspaces.sql`) whenever installed (`to_regclass`), with zero runtime
 *    DDL inside API routes, and falls back cleanly to case-scoped `settings` rows under the exact same transactional
 *    `pg_advisory_xact_lock` + `FOR UPDATE` CAS lock on un-migrated 75-migration databases.
 * 3. Enforces strict optimistic concurrency (`expectedRevision`): concurrent writers serialize on the row lock,
 *    and the stale writer receives `409 REVISION_CONFLICT` with zero lost updates.
 * 4. Writes immutable `audit_log` rows atomically inside the SAME transaction (`insertAuditRow`) so audit failure
 *    rolls back the clinical write.
 * 5. Enforces section-scoped typed commands and deep privacy/blind-create scrubbing across `orthoCoreCase`.
 */

export type OrthoWorkspaceCommandType =
  | "save_questionnaire"
  | "save_exam"
  | "save_analysis_draft"
  | "approve_analysis"
  | "save_diagnosis_draft"
  | "approve_diagnosis"
  | "save_plan_draft"
  | "approve_plan"
  | "reopen_approved"
  | "save_retention"
  | "save_presentation"
  | "save_orthocore_draft"
  | "save_workspace";

export function workspaceScopeKey(orthoCaseId?: number | null): string {
  return typeof orthoCaseId === "number" && Number.isSafeInteger(orthoCaseId) && orthoCaseId > 0
    ? `case:${orthoCaseId}`
    : "intake";
}

export function workspaceStorageKey(patientId: number, orthoCaseId?: number | null): string {
  const scope = workspaceScopeKey(orthoCaseId);
  return scope === "intake"
    ? `ortho.workspace.v1.p.${patientId}`
    : `ortho.workspace.v2.p.${patientId}.c.${orthoCaseId}`;
}

export function mergeOrthoWorkspaceRecord(
  patientId: number,
  raw: unknown,
  orthoCaseId: number | null = null,
): OrthoWorkspaceRecord {
  const base = createDefaultOrthoWorkspace(patientId, orthoCaseId);
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<OrthoWorkspaceRecord>;
  const resolvedCaseId =
    orthoCaseId !== null
      ? orthoCaseId
      : typeof obj.orthoCaseId === "number" && obj.orthoCaseId > 0
        ? obj.orthoCaseId
        : null;
  return {
    ...base,
    ...obj,
    schemaVersion: 1,
    patientId,
    orthoCaseId: resolvedCaseId,
    revision: typeof obj.revision === "number" && Number.isInteger(obj.revision) && obj.revision >= 0 ? obj.revision : 0,
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
 * Deeply strips any workspace sections, nested `orthoCoreCase` properties, or sensitive fields
 * that the user is not permitted to view according to central + ortho capabilities (TD-06).
 */
export function filterWorkspaceByPrivacy(
  record: OrthoWorkspaceRecord,
  access: ResolvedOrthoAccess,
): { filtered: OrthoWorkspaceRecord; hiddenSections: OrthoSectionKey[] } {
  const blank = createDefaultOrthoWorkspace(record.patientId, record.orthoCaseId);
  const hiddenSections: OrthoSectionKey[] = [];

  // True blind-create mode: user without records.read receives a clean empty template for entry only!
  if (!access.permissions["records.read"]) {
    return {
      filtered: { ...blank, orthoCoreCase: undefined },
      hiddenSections: [
        "medical_history",
        "exam",
        "media",
        "ceph",
        "photo_analysis",
        "model3d",
        "measurements",
        "diagnosis",
        "plan",
        "appliances",
        "sessions",
        "retention",
        "reports",
      ],
    };
  }

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

  // Deep scrub nested orthoCoreCase snapshot so no hidden section, clinical note, timeline, or financial field leaks
  if (next.orthoCoreCase && typeof next.orthoCoreCase === "object") {
    const oc = structuredClone(next.orthoCoreCase as Record<string, unknown>);
    if (!access.sections.medical_history || !access.fields.medicalHistory) {
      delete oc.questionnaire;
      delete oc.medicalAlerts;
    }
    if (!access.sections.exam) delete oc.clinicalExam;
    if (!access.sections.media || !access.permissions["photos.view"] || !access.fields.previousPhotos) {
      oc.media = [];
    }
    if (!access.sections.ceph) {
      oc.cephAnalyses = [];
    }
    if (!access.sections.measurements && !access.sections.ceph && !access.sections.photo_analysis) {
      oc.analyses = [];
    }
    if (!access.sections.diagnosis) {
      oc.problems = [];
      delete oc.diagnosis;
    }
    if (!access.sections.plan && !access.sections.appliances) {
      delete oc.treatmentPlan;
    }
    if (!access.sections.sessions) oc.sessions = [];
    if (!access.sections.retention) delete oc.retention;
    if (!access.sections.reports) oc.customReports = [];
    if (!access.fields.clinicalNotes) {
      oc.timeline = [];
      delete oc.notes;
      if ("privateNotes" in oc) oc.privateNotes = "";
      if (oc.clinicalExam && typeof oc.clinicalExam === "object") {
        const ce = oc.clinicalExam as Record<string, unknown>;
        delete ce.notes;
      }
    }
    if (!access.fields.internalNotes) {
      delete oc.internalNotes;
      if ("privateNotes" in oc) oc.privateNotes = "";
    }
    if (!access.fields.financialBalances || !access.permissions["finance.view"]) {
      delete oc.financial;
      delete oc.financialSummary;
      delete oc.feeTotal;
      delete oc.paidTotal;
    }
    if (!access.fields.identityFields) {
      delete oc.phone;
      delete oc.nationalId;
      delete oc.address;
    }
    next.orthoCoreCase = oc;
  }

  return { filtered: next, hiddenSections };
}

async function hasNormalizedWorkspaceTable(runner: Pick<DbClient, "query">): Promise<boolean> {
  try {
    const { rows } = await runner.query<{ reg: string | null }>(
      "SELECT to_regclass('public.ortho_clinical_workspaces')::text AS reg",
    );
    return Boolean(rows[0]?.reg);
  } catch {
    return false;
  }
}

interface NormalizedWorkspaceRow {
  id: string | number;
  patient_id: number;
  ortho_case_id: number | null;
  revision: number;
  dentition_stage: OrthoWorkspaceRecord["clinicalExam"]["dentitionStage"];
  questionnaire: unknown;
  clinical_exam: unknown;
  facial_photo: unknown;
  model_3d: unknown;
  cbct: unknown;
  cast_inputs: unknown;
  approved_analyses: unknown;
  problems: unknown;
  diagnosis_summary: unknown;
  treatment_plan: unknown;
  retention: unknown;
  presentation: unknown;
  orthocore_case: unknown;
  updated_by: string | null;
  updated_at: Date | string | null;
}

function rowToWorkspaceRecord(row: NormalizedWorkspaceRow): OrthoWorkspaceRecord {
  const baseExam =
    row.clinical_exam && typeof row.clinical_exam === "object"
      ? (row.clinical_exam as Record<string, unknown>)
      : {};
  return mergeOrthoWorkspaceRecord(
    row.patient_id,
    {
      schemaVersion: 1,
      patientId: row.patient_id,
      orthoCaseId: row.ortho_case_id,
      revision: Number(row.revision),
      questionnaire: row.questionnaire,
      clinicalExam: {
        ...baseExam,
        ...(row.dentition_stage ? { dentitionStage: row.dentition_stage } : {}),
      },
      facialPhoto: row.facial_photo,
      model3d: row.model_3d,
      cbct: row.cbct,
      castInputs: row.cast_inputs,
      approvedAnalyses: row.approved_analyses,
      problems: row.problems,
      diagnosisSummary: row.diagnosis_summary,
      treatmentPlan: row.treatment_plan,
      retention: row.retention,
      presentation: row.presentation,
      orthoCoreCase: row.orthocore_case && typeof row.orthocore_case === "object" ? row.orthocore_case : undefined,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    },
    row.ortho_case_id,
  );
}

async function readWorkspaceOnClient(
  runner: Pick<DbClient, "query">,
  patientId: number,
  orthoCaseId: number | null,
  forUpdate: boolean,
): Promise<{ normalizedTable: boolean; workspaceRowId: number | null; record: OrthoWorkspaceRecord }> {
  const scope = workspaceScopeKey(orthoCaseId);
  const normalized = await hasNormalizedWorkspaceTable(runner);
  if (normalized) {
    const lockClause = forUpdate ? " FOR UPDATE" : "";
    const { rows } = await runner.query<NormalizedWorkspaceRow>(
      `SELECT * FROM ortho_clinical_workspaces WHERE patient_id = $1 AND scope_key = $2${lockClause}`,
      [patientId, scope],
    );
    if (rows[0]) {
      return {
        normalizedTable: true,
        workspaceRowId: Number(rows[0].id),
        record: rowToWorkspaceRecord(rows[0]),
      };
    }
    return {
      normalizedTable: true,
      workspaceRowId: null,
      record: createDefaultOrthoWorkspace(patientId, orthoCaseId),
    };
  }

  const key = workspaceStorageKey(patientId, orthoCaseId);
  const lockClause = forUpdate ? " FOR UPDATE" : "";
  const { rows } = await runner.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = $1${lockClause}`,
    [key],
  );
  if (rows[0]?.value) {
    try {
      return {
        normalizedTable: false,
        workspaceRowId: null,
        record: mergeOrthoWorkspaceRecord(patientId, JSON.parse(rows[0].value), orthoCaseId),
      };
    } catch {
      return {
        normalizedTable: false,
        workspaceRowId: null,
        record: createDefaultOrthoWorkspace(patientId, orthoCaseId),
      };
    }
  }

  // Seamless one-way fallback read for legacy v1 intake record only when reading the first/intake case
  if (orthoCaseId !== null) {
    const legacyKey = workspaceStorageKey(patientId, null);
    const legacy = await runner.query<{ value: string }>(
      `SELECT value FROM settings WHERE key = $1`,
      [legacyKey],
    );
    if (legacy.rows[0]?.value) {
      try {
        const parsed = JSON.parse(legacy.rows[0].value) as Partial<OrthoWorkspaceRecord>;
        if (!parsed.orthoCaseId || parsed.orthoCaseId === orthoCaseId) {
          return {
            normalizedTable: false,
            workspaceRowId: null,
            record: { ...mergeOrthoWorkspaceRecord(patientId, parsed, orthoCaseId), revision: 0 },
          };
        }
      } catch {
        // ignore corrupt legacy JSON
      }
    }
  }

  return {
    normalizedTable: false,
    workspaceRowId: null,
    record: createDefaultOrthoWorkspace(patientId, orthoCaseId),
  };
}

export async function loadOrthoWorkspaceRecord(
  patientId: number,
  orthoCaseId: number | null = null,
): Promise<OrthoWorkspaceRecord> {
  if (typeof db.ensureSchema === "function") await db.ensureSchema();
  const pool = typeof db.getPool === "function" ? db.getPool() : null;
  if (!pool) return createDefaultOrthoWorkspace(patientId, orthoCaseId);
  const loaded = await readWorkspaceOnClient(pool, patientId, orthoCaseId, false);
  return loaded.record;
}

export function applyTypedSectionCommand(
  existing: OrthoWorkspaceRecord,
  command: OrthoWorkspaceCommandType,
  incoming: Partial<OrthoWorkspaceRecord>,
  actorUsername: string,
  reopenReason?: string,
): OrthoWorkspaceRecord {
  const now = new Date().toISOString();
  switch (command) {
    case "save_questionnaire":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        { ...existing, questionnaire: incoming.questionnaire ?? existing.questionnaire, orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase },
        existing.orthoCaseId,
      );
    case "save_exam":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        {
          ...existing,
          clinicalExam: incoming.clinicalExam ?? existing.clinicalExam,
          orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase,
        },
        existing.orthoCaseId,
      );
    case "save_analysis_draft":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        {
          ...existing,
          facialPhoto: incoming.facialPhoto ?? existing.facialPhoto,
          model3d: incoming.model3d ?? existing.model3d,
          cbct: incoming.cbct ?? existing.cbct,
          castInputs: incoming.castInputs ?? existing.castInputs,
          orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase,
        },
        existing.orthoCaseId,
      );
    case "approve_analysis":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        {
          ...existing,
          approvedAnalyses: incoming.approvedAnalyses ?? existing.approvedAnalyses,
          orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase,
        },
        existing.orthoCaseId,
      );
    case "save_diagnosis_draft":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        {
          ...existing,
          problems: incoming.problems ?? existing.problems,
          diagnosisSummary: {
            ...(incoming.diagnosisSummary ?? existing.diagnosisSummary),
            approvedBy: existing.diagnosisSummary.approvedBy,
            approvedAt: existing.diagnosisSummary.approvedAt,
          },
          orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase,
        },
        existing.orthoCaseId,
      );
    case "approve_diagnosis":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        {
          ...existing,
          problems: incoming.problems ?? existing.problems,
          diagnosisSummary: {
            ...(incoming.diagnosisSummary ?? existing.diagnosisSummary),
            approvedBy: actorUsername,
            approvedAt: incoming.diagnosisSummary?.approvedAt || now,
          },
          orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase,
        },
        existing.orthoCaseId,
      );
    case "save_plan_draft":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        {
          ...existing,
          treatmentPlan: {
            ...(incoming.treatmentPlan ?? existing.treatmentPlan),
            approvedBy: existing.treatmentPlan.approvedBy,
            approvedAt: existing.treatmentPlan.approvedAt,
          },
          orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase,
        },
        existing.orthoCaseId,
      );
    case "approve_plan":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        {
          ...existing,
          treatmentPlan: {
            ...(incoming.treatmentPlan ?? existing.treatmentPlan),
            approvedBy: actorUsername,
            approvedAt: incoming.treatmentPlan?.approvedAt || now,
          },
          orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase,
        },
        existing.orthoCaseId,
      );
    case "reopen_approved":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        {
          ...existing,
          diagnosisSummary: {
            ...existing.diagnosisSummary,
            approvedBy: null,
            approvedAt: null,
            reopenedBy: actorUsername,
            reopenedAt: now,
            reopenReason: reopenReason ?? null,
          },
          treatmentPlan: {
            ...existing.treatmentPlan,
            approvedBy: null,
            approvedAt: null,
          },
        },
        existing.orthoCaseId,
      );
    case "save_retention":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        { ...existing, retention: incoming.retention ?? existing.retention, orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase },
        existing.orthoCaseId,
      );
    case "save_presentation":
      return mergeOrthoWorkspaceRecord(
        existing.patientId,
        { ...existing, presentation: incoming.presentation ?? existing.presentation, orthoCoreCase: incoming.orthoCoreCase ?? existing.orthoCoreCase },
        existing.orthoCaseId,
      );
    default:
      return mergeOrthoWorkspaceRecord(existing.patientId, { ...existing, ...incoming }, existing.orthoCaseId);
  }
}

export async function saveOrthoWorkspaceRecord(
  patientId: number,
  incoming: Partial<OrthoWorkspaceRecord>,
  actorUsername: string,
  expectedRevision?: number,
  options?: {
    orthoCaseId?: number | null;
    actorRole?: string;
    command?: OrthoWorkspaceCommandType;
    reason?: string;
    blindCreate?: boolean;
  },
): Promise<
  | { ok: true; record: OrthoWorkspaceRecord }
  | { ok: false; status: number; code?: string; message: string; currentRevision?: number }
> {
  if (typeof db.ensureSchema === "function") await db.ensureSchema();
  const pool = typeof db.getPool === "function" ? db.getPool() : null;
  if (!pool) {
    return { ok: false, status: 503, code: "DB_UNAVAILABLE", message: "قاعدة البيانات غير متاحة." };
  }

  const orthoCaseId =
    options?.orthoCaseId !== undefined
      ? options.orthoCaseId
      : typeof incoming.orthoCaseId === "number" && incoming.orthoCaseId > 0
        ? incoming.orthoCaseId
        : null;
  const scope = workspaceScopeKey(orthoCaseId);
  const command: OrthoWorkspaceCommandType = options?.command ?? "save_workspace";
  const actorRole = options?.actorRole ?? "doctor";

  return withIsolation(pool, "READ COMMITTED", async (client) => {
    // Serialize concurrent writes on this exact (patientId, orthoCaseId) workspace before reading current revision
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `ortho.workspace:${patientId}:${scope}`,
    ]);

    const currentLoaded = await readWorkspaceOnClient(client, patientId, orthoCaseId, true);
    const existing = currentLoaded.record;

    if (
      typeof expectedRevision !== "number" ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision !== existing.revision
    ) {
      return {
        ok: false as const,
        status: 409,
        code: "REVISION_CONFLICT",
        message: "تم تعديل ملف التقويم من مستخدم آخر أو بدون رقم إصدار محدّث. حدّث الصفحة قبل الحفظ لمنع الكتابة فوق التعديلات.",
        currentRevision: existing.revision,
      };
    }

    const merged = applyTypedSectionCommand(existing, command, incoming, actorUsername, options?.reason);
    const next: OrthoWorkspaceRecord = {
      ...merged,
      patientId,
      orthoCaseId,
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: actorUsername,
    };

    if (currentLoaded.normalizedTable) {
      const { rows: [savedRow] } = await client.query<{ id: string | number }>(
        `INSERT INTO ortho_clinical_workspaces (
           patient_id, ortho_case_id, scope_key, revision, dentition_stage,
           questionnaire, clinical_exam, facial_photo, model_3d, cbct,
           cast_inputs, approved_analyses, problems, diagnosis_summary,
           treatment_plan, retention, presentation, orthocore_case,
           updated_by, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
           $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
           $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb,
           $19, NOW()
         )
         ON CONFLICT (patient_id, scope_key) DO UPDATE SET
           ortho_case_id = EXCLUDED.ortho_case_id,
           revision = EXCLUDED.revision,
           dentition_stage = EXCLUDED.dentition_stage,
           questionnaire = EXCLUDED.questionnaire,
           clinical_exam = EXCLUDED.clinical_exam,
           facial_photo = EXCLUDED.facial_photo,
           model_3d = EXCLUDED.model_3d,
           cbct = EXCLUDED.cbct,
           cast_inputs = EXCLUDED.cast_inputs,
           approved_analyses = EXCLUDED.approved_analyses,
           problems = EXCLUDED.problems,
           diagnosis_summary = EXCLUDED.diagnosis_summary,
           treatment_plan = EXCLUDED.treatment_plan,
           retention = EXCLUDED.retention,
           presentation = EXCLUDED.presentation,
           orthocore_case = EXCLUDED.orthocore_case,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
         WHERE ortho_clinical_workspaces.revision = $20
         RETURNING id`,
        [
          patientId,
          orthoCaseId,
          scope,
          next.revision,
          next.clinicalExam.dentitionStage,
          JSON.stringify(next.questionnaire),
          JSON.stringify(next.clinicalExam),
          JSON.stringify(next.facialPhoto),
          JSON.stringify(next.model3d),
          JSON.stringify(next.cbct),
          JSON.stringify(next.castInputs),
          JSON.stringify(next.approvedAnalyses),
          JSON.stringify(next.problems),
          JSON.stringify(next.diagnosisSummary),
          JSON.stringify(next.treatmentPlan),
          JSON.stringify(next.retention),
          JSON.stringify(next.presentation),
          next.orthoCoreCase ? JSON.stringify(next.orthoCoreCase) : null,
          actorUsername,
          existing.revision,
        ],
      );
      if (!savedRow) {
        return {
          ok: false as const,
          status: 409,
          code: "REVISION_CONFLICT",
          message: "تعارض إصدار متزامن أثناء حفظ ملف التقويم.",
          currentRevision: existing.revision,
        };
      }
      await client.query(
        `INSERT INTO ortho_clinical_workspace_revisions (
           workspace_id, patient_id, ortho_case_id, revision, command_type, actor_username, actor_role, reason, snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          Number(savedRow.id),
          patientId,
          orthoCaseId,
          next.revision,
          command,
          actorUsername,
          actorRole,
          options?.reason ?? null,
          JSON.stringify(next),
        ],
      );
    } else {
      await client.query(
        `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [workspaceStorageKey(patientId, orthoCaseId), JSON.stringify(next)],
      );
    }

    // Atomic audit row inside the SAME transaction: if audit insertion fails, the clinical write rolls back!
    if (typeof db.insertAuditRow === "function") {
      await db.insertAuditRow(client, {
        action: "ortho.workspace_update",
        entity: "patient",
        entityId: String(patientId),
        entityLabel: `ملف تقويم مريض #${patientId}${orthoCaseId ? ` (حالة #${orthoCaseId})` : ""}`,
        details: {
          الأمر: command,
          النطاق: scope,
          رقم_الإصدار: next.revision,
          إدخال_أعمى: Boolean(options?.blindCreate),
          ...(options?.reason ? { السبب: options.reason.slice(0, 240) } : {}),
        },
        actor: actorUsername,
        actorRole,
      });
    }

    return { ok: true as const, record: next };
  });
}

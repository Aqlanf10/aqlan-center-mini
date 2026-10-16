/**
 * Proposed case-strategy contract. Pure only: no persistence or permission grant.
 * The route/store must authorize the actor and lock/re-read these canonical IDs
 * inside its transaction. A successful parser is never write authorization.
 */
export const ORTHO_STRATEGY_SCHEMA_VERSION = 1 as const;
export const ORTHO_STRATEGY_LIMITS = {
  rows: 30, itemsPerRow: 8, objective: 1000, strategy: 2000, rationale: 1000, reason: 500,
} as const;

type Checked<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
const failure = (code: string, message: string): Checked<never> => ({ ok: false, code, message });
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.getOwnPropertySymbols(value).length === 0
  && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const authoredText = (value: unknown, max: number): Checked<string | null> => {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.length > max) return failure("invalid_text", "نص غير صالح أو أطول من الحد المسموح.");
  return { ok: true, value: value.trim() || null };
};

export interface StrategyScope { patientId: number; orthoCaseId: number; clinicalCaseId: number }
export interface StrategyRowDraft {
  problemId: number;
  objective: string | null;
  strategy: string | null;
  planItemIds: number[];
  rationale: string | null;
}
export interface StrategyCommand {
  schemaVersion: 1;
  commandId: string;
  expectedRevisionId: number | null;
  reason: string;
  rows: StrategyRowDraft[];
}

/** Strict shape: client cannot supply patient/case/actor/time/status/finance fields. */
export function checkStrategyCommand(raw: unknown): Checked<StrategyCommand> {
  if (!object(raw) || !exactKeys(raw, ["schemaVersion", "commandId", "expectedRevisionId", "reason", "rows"])) {
    return failure("invalid_command", "بنية مراجعة الخطة غير صالحة.");
  }
  if (raw.schemaVersion !== ORTHO_STRATEGY_SCHEMA_VERSION) return failure("unsupported_schema", "إصدار نموذج الخطة غير مدعوم.");
  if (typeof raw.commandId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(raw.commandId)) {
    return failure("invalid_command_id", "معرّف الحفظ غير صالح؛ لا تُكرر طلبًا مجهول النتيجة.");
  }
  if (raw.expectedRevisionId !== null && !id(raw.expectedRevisionId)) return failure("invalid_revision", "النسخة المرجعية غير صالحة.");
  const reason = authoredText(raw.reason, ORTHO_STRATEGY_LIMITS.reason);
  if (!reason.ok || reason.value === null) return failure("reason_required", "اكتب سبب تسجيل هذه النسخة.");
  if (!Array.isArray(raw.rows) || raw.rows.length === 0 || raw.rows.length > ORTHO_STRATEGY_LIMITS.rows) {
    return failure("invalid_rows", "أضف سطر مشكلة واحدًا على الأقل ضمن الحد المسموح.");
  }
  const rows: StrategyRowDraft[] = [];
  for (const row of raw.rows) {
    if (!object(row) || !exactKeys(row, ["problemId", "objective", "strategy", "planItemIds", "rationale"]) || !id(row.problemId)) {
      return failure("invalid_row", "سطر المشكلة أو مرجعها غير صالح.");
    }
    const objective = authoredText(row.objective, ORTHO_STRATEGY_LIMITS.objective);
    const strategy = authoredText(row.strategy, ORTHO_STRATEGY_LIMITS.strategy);
    const rationale = authoredText(row.rationale, ORTHO_STRATEGY_LIMITS.rationale);
    if (!objective.ok || !strategy.ok || !rationale.ok) return failure("invalid_text", "راجع طول ونوع نصوص الهدف والخطة والمبرر.");
    if (!Array.isArray(row.planItemIds) || row.planItemIds.length > ORTHO_STRATEGY_LIMITS.itemsPerRow
      || row.planItemIds.some((value) => !id(value)) || new Set(row.planItemIds).size !== row.planItemIds.length) {
      return failure("invalid_item_links", "مراجع بنود الخطة غير صالحة أو مكررة في السطر.");
    }
    rows.push({ problemId: row.problemId, objective: objective.value, strategy: strategy.value,
      planItemIds: [...row.planItemIds], rationale: rationale.value });
  }
  return { ok: true, value: { schemaVersion: 1, commandId: raw.commandId,
    expectedRevisionId: raw.expectedRevisionId as number | null, reason: reason.value, rows } };
}

/** Minimal clinical references from authorized joins, never a spread of PlanItem. */
export interface StrategyProblemReference {
  id: number; patientId: number; caseId: number | null; label: string; site: string | null; status: string | null;
}
export interface StrategyPlanItemReference {
  id: number; patientId: number; caseId: number | null; serviceName: string; toothCode: number | null; caseSite: string | null;
  status: string | null;
}
export interface StrategyCanonicalContext {
  /** Server-built after current actor/patient authorization, never client JSON. */
  patientId: number;
  orthoCase: { id: number; patientId: number };
  clinicalCase: { id: number; patientId: number; orthoCaseId: number | null } | null;
  problems: readonly StrategyProblemReference[];
  problemLookupState: "ready" | "unavailable";
  planItems: readonly StrategyPlanItemReference[];
  planVisibility: "allowed" | "restricted" | "unavailable";
  clinicalWriteAllowed: boolean;
  /** Current canEditPlans decision, rechecked by the writer, not client input. */
  planLinksWritable: boolean;
}
export interface StrategyProblemSnapshot { id: number; label: string; site: string | null }
export interface StrategyPlanItemSnapshot { id: number; serviceName: string; toothCode: number | null; caseSite: string | null }
export interface StrategySavedRow {
  problem: StrategyProblemSnapshot;
  objective: string | null;
  strategy: string | null;
  planItems: StrategyPlanItemSnapshot[];
  rationale: string | null;
}
export type StrategyRecordingContext = "current" | "retrospective";
export interface StrategyRevision extends StrategyScope {
  /** Immutable recording provenance; never an authorization or current-owner key. */
  recordedPatientId: number;
  id: number; schemaVersion: 1; version: number; supersedesRevisionId: number | null;
  recordingContext: StrategyRecordingContext;
  createdAt: string; createdBy: string; reason: string; rows: StrategySavedRow[];
}

/** Strict stored/transport decoder. Corrupt history is an error, never [].
 * Store adapters supply only this clinical shape; command/finance/audit internals
 * must not be cast or spread into it. Text is preserved exactly, not repaired.
 */
export function decodeStrategyRevision(raw: unknown, scope: StrategyScope): Checked<StrategyRevision> {
  const invalid = () => failure("invalid_stored_revision", "تعذّر التحقق من نسخة الخطة المحفوظة؛ لا تعني هذه النتيجة أن السجل فارغ.");
  const validText = (value: unknown, max: number, nullable = true) => value === null ? nullable
    : typeof value === "string" && value.length <= max && value.trim().length > 0;
  if (!object(raw) || !exactKeys(raw, ["id", "patientId", "recordedPatientId", "orthoCaseId", "clinicalCaseId", "schemaVersion", "version",
    "supersedesRevisionId", "recordingContext", "createdAt", "createdBy", "reason", "rows"])
    || !id(raw.id) || !id(raw.patientId) || !id(raw.recordedPatientId) || !id(raw.orthoCaseId) || !id(raw.clinicalCaseId)
    || raw.patientId !== scope.patientId || raw.orthoCaseId !== scope.orthoCaseId || raw.clinicalCaseId !== scope.clinicalCaseId
    || raw.schemaVersion !== ORTHO_STRATEGY_SCHEMA_VERSION || !id(raw.version)
    || (raw.supersedesRevisionId !== null && !id(raw.supersedesRevisionId))
    || (raw.version === 1) !== (raw.supersedesRevisionId === null) || raw.supersedesRevisionId === raw.id
    || (raw.recordingContext !== "current" && raw.recordingContext !== "retrospective")
    || typeof raw.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.createdAt)
    || !Number.isFinite(new Date(raw.createdAt).getTime()) || new Date(raw.createdAt).toISOString() !== raw.createdAt
    || !validText(raw.createdBy, 200, false) || !validText(raw.reason, ORTHO_STRATEGY_LIMITS.reason, false)
    || !Array.isArray(raw.rows) || raw.rows.length === 0 || raw.rows.length > ORTHO_STRATEGY_LIMITS.rows) return invalid();
  const rows: StrategySavedRow[] = [];
  for (const row of raw.rows) {
    if (!object(row) || !exactKeys(row, ["problem", "objective", "strategy", "planItems", "rationale"])
      || !object(row.problem) || !exactKeys(row.problem, ["id", "label", "site"]) || !id(row.problem.id)
      || !validText(row.problem.label, 2000, false) || !validText(row.problem.site, 1000)
      || !validText(row.objective, ORTHO_STRATEGY_LIMITS.objective) || !validText(row.strategy, ORTHO_STRATEGY_LIMITS.strategy)
      || !validText(row.rationale, ORTHO_STRATEGY_LIMITS.rationale) || !Array.isArray(row.planItems)
      || row.planItems.length > ORTHO_STRATEGY_LIMITS.itemsPerRow) return invalid();
    const planItems: StrategyPlanItemSnapshot[] = [];
    const seen = new Set<number>();
    for (const item of row.planItems) {
      if (!object(item) || !exactKeys(item, ["id", "serviceName", "toothCode", "caseSite"]) || !id(item.id)
        || seen.has(item.id) || !validText(item.serviceName, 2000, false) || !validText(item.caseSite, 1000)
        || (item.toothCode !== null && !id(item.toothCode))) return invalid();
      seen.add(item.id);
      planItems.push({ id: item.id, serviceName: item.serviceName as string,
        toothCode: item.toothCode as number | null, caseSite: item.caseSite as string | null });
    }
    rows.push({ problem: { id: row.problem.id, label: row.problem.label as string, site: row.problem.site as string | null },
      objective: row.objective as string | null, strategy: row.strategy as string | null,
      rationale: row.rationale as string | null, planItems });
  }
  return { ok: true, value: { id: raw.id, patientId: raw.patientId, recordedPatientId: raw.recordedPatientId, orthoCaseId: raw.orthoCaseId, clinicalCaseId: raw.clinicalCaseId,
    schemaVersion: 1, version: raw.version, supersedesRevisionId: raw.supersedesRevisionId as number | null,
    recordingContext: raw.recordingContext,
    createdAt: raw.createdAt, createdBy: raw.createdBy as string, reason: raw.reason as string, rows } };
}

export function strategyScope(context: StrategyCanonicalContext): Checked<StrategyScope> {
  if (!id(context.patientId) || !id(context.orthoCase.id) || context.orthoCase.patientId !== context.patientId) {
    return failure("scope_mismatch", "تعذّر التحقق من انتماء حالة التقويم للمريض.");
  }
  const bridge = context.clinicalCase;
  if (bridge === null) return failure("bridge_missing", "اربط حالة التقويم بالمشاكل وبنود الخطة أولًا بالإجراء الصريح الموجود.");
  if (!id(bridge.id) || bridge.patientId !== context.patientId || bridge.orthoCaseId !== context.orthoCase.id) {
    return failure("scope_mismatch", "الرابط السريري لا يطابق حالة التقويم المحددة.");
  }
  return { ok: true, value: { patientId: context.patientId, orthoCaseId: context.orthoCase.id, clinicalCaseId: bridge.id } };
}

/** Snapshot only references proven in the transaction. Never create/link entities. */
export function bindStrategyRows(
  command: StrategyCommand, context: StrategyCanonicalContext, previous: StrategyRevision | null,
): Checked<StrategySavedRow[]> {
  const scope = strategyScope(context);
  if (!scope.ok) return scope;
  if (!context.clinicalWriteAllowed) return failure("clinical_edit_denied", "تعديل الخطة السريرية غير مصرّح لهذا الحساب.");
  if (context.problemLookupState !== "ready") return failure("problems_unavailable", "تعذّر التحقق من قائمة المشاكل؛ لا تحفظ روابط غير متحققة.");
  if (previous !== null && (previous.patientId !== scope.value.patientId || previous.orthoCaseId !== scope.value.orthoCaseId
    || previous.clinicalCaseId !== scope.value.clinicalCaseId)) {
    return failure("revision_scope_mismatch", "النسخة السابقة لا تنتمي إلى الحالة المحددة.");
  }
  if (command.expectedRevisionId !== (previous?.id ?? null)) return failure("stale_revision", "تغيرت نسخة الخطة؛ أعد قراءتها قبل حفظ مراجعة جديدة.");
  // Removing or retaining existing links also requires current plan authority.
  // Empty replacement rows cannot bypass revoked access to a linked revision.
  const usesPlanLinks = command.rows.some((row) => row.planItemIds.length > 0)
    || Boolean(previous?.rows.some((row) => row.planItems.length > 0));
  if (usesPlanLinks && (context.planVisibility !== "allowed" || !context.planLinksWritable)) {
    return failure("plan_links_unavailable", "لم تُتحقق صلاحية قراءة بنود الخطة المطلوبة.");
  }
  const rows: StrategySavedRow[] = [];
  for (const row of command.rows) {
    const problems = context.problems.filter((value) => value.id === row.problemId);
    if (problems.length !== 1 || problems[0].patientId !== scope.value.patientId || problems[0].caseId !== scope.value.clinicalCaseId) {
      return failure("problem_scope_mismatch", "المشكلة المختارة غير مرتبطة بهذه الحالة السريرية.");
    }
    const problem = problems[0];
    const planItems: StrategyPlanItemSnapshot[] = [];
    for (const itemId of row.planItemIds) {
      const items = context.planItems.filter((value) => value.id === itemId);
      if (items.length !== 1 || items[0].patientId !== scope.value.patientId || items[0].caseId !== scope.value.clinicalCaseId) {
        return failure("item_scope_mismatch", "بند الخطة المختار غير مرتبط بهذه الحالة السريرية.");
      }
      const item = items[0];
      planItems.push({ id: item.id, serviceName: item.serviceName, toothCode: item.toothCode, caseSite: item.caseSite });
    }
    rows.push({ problem: { id: problem.id, label: problem.label, site: problem.site },
      objective: row.objective, strategy: row.strategy, planItems, rationale: row.rationale });
  }
  return { ok: true, value: rows };
}

export type StrategyCurrentLink = { state: "available"; status: string | null }
  | { state: "missing" | "moved" | "unavailable"; status: null };
export interface StrategyProjectedRow {
  problem: StrategyProblemSnapshot;
  currentProblem: StrategyCurrentLink;
  objective: string | null;
  strategy: string | null;
  rationale: string | null;
  planLinks: { state: "restricted" | "unavailable" }
    | { state: "allowed"; items: (StrategyPlanItemSnapshot & { current: StrategyCurrentLink })[] };
}
export interface StrategyProjection extends StrategyScope {
  /** Original recording identity, distinct from the authorized current patientId. */
  recordedPatientId: number;
  schemaVersion: 1; revisionId: number; version: number; supersedesRevisionId: number | null;
  recordingContext: StrategyRecordingContext;
  createdAt: string; createdBy: string; reason: string;
  rows: StrategyProjectedRow[];
}
function currentLink(
  referenceId: number, values: readonly { id: number; patientId: number; caseId: number | null; status: string | null }[], scope: StrategyScope,
): StrategyCurrentLink {
  const matches = values.filter((value) => value.id === referenceId);
  if (matches.length === 0) return { state: "missing", status: null };
  if (matches.length !== 1 || matches[0].patientId !== scope.patientId) return { state: "unavailable", status: null };
  if (matches[0].caseId !== scope.clinicalCaseId) return { state: "moved", status: null };
  return { state: "available", status: matches[0].status };
}

/** One authorized read projection for prescription, visit reference and export.
 * Historical snapshots stay separate from current statuses. No status is mapped
 * to completion/clearance and no diagnosis or performed treatment is generated.
 */
export function projectStrategyRevision(revision: StrategyRevision, context: StrategyCanonicalContext): Checked<StrategyProjection> {
  const scope = strategyScope(context);
  if (!scope.ok) return scope;
  if (revision.patientId !== scope.value.patientId || revision.orthoCaseId !== scope.value.orthoCaseId
    || revision.clinicalCaseId !== scope.value.clinicalCaseId || revision.schemaVersion !== ORTHO_STRATEGY_SCHEMA_VERSION) {
    return failure("revision_scope_mismatch", "نسخة الخطة لا تنتمي إلى الحالة المحددة.");
  }
  return { ok: true, value: { ...scope.value, recordedPatientId: revision.recordedPatientId, schemaVersion: 1, revisionId: revision.id, version: revision.version,
    supersedesRevisionId: revision.supersedesRevisionId,
    recordingContext: revision.recordingContext,
    createdAt: revision.createdAt, createdBy: revision.createdBy, reason: revision.reason,
    rows: revision.rows.map<StrategyProjectedRow>((row) => ({
      problem: { id: row.problem.id, label: row.problem.label, site: row.problem.site },
      currentProblem: context.problemLookupState === "ready" ? currentLink(row.problem.id, context.problems, scope.value)
        : { state: "unavailable", status: null },
      objective: row.objective, strategy: row.strategy, rationale: row.rationale,
      planLinks: context.planVisibility === "allowed" ? { state: "allowed", items: row.planItems.map((item) => ({
        id: item.id, serviceName: item.serviceName, toothCode: item.toothCode, caseSite: item.caseSite,
        current: currentLink(item.id, context.planItems, scope.value),
      })) } : { state: context.planVisibility },
    })) } };
}

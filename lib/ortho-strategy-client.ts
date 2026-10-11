import { decodeStrategyRevision, type StrategyCurrentLink, type StrategyProjection, type StrategyScope } from "./ortho-treatment-strategy";
import type { OrthoStrategyReadResult } from "./ortho-treatment-strategy-store";

export type StrategyRead = Extract<OrthoStrategyReadResult, { ok: true }>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === "string";
const optionalText = (value: unknown): value is string | null => value === null || text(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join("|") === [...expected].sort().join("|");
function currentLink(raw: unknown): StrategyCurrentLink | null {
  if (!record(raw) || !keys(raw, ["state", "status"])) return null;
  if (raw.state === "available" && optionalText(raw.status)) return { state: "available", status: raw.status };
  if (typeof raw.state === "string" && ["missing", "moved", "unavailable"].includes(raw.state) && raw.status === null) {
    return { state: raw.state as "missing" | "moved" | "unavailable", status: null };
  }
  return null;
}

/** Strict clinical snapshot decoding is reused; transport-only current status
 * and redaction are decoded separately. No client flag grants server authority. */
export function readStrategyProjection(raw: unknown, scope: StrategyScope): StrategyProjection | null {
  if (!record(raw) || !keys(raw, ["patientId", "recordedPatientId", "orthoCaseId", "clinicalCaseId", "schemaVersion", "revisionId", "version", "supersedesRevisionId", "recordingContext", "createdAt", "createdBy", "reason", "rows"]) || !Array.isArray(raw.rows)) return null;
  const rows: StrategyProjection["rows"] = [];
  for (const item of raw.rows) {
    if (!record(item) || !keys(item, ["problem", "currentProblem", "objective", "strategy", "rationale", "planLinks"]) || !record(item.planLinks)) return null;
    const problem = currentLink(item.currentProblem); if (!problem) return null;
    const links = item.planLinks;
    if (links.state === "allowed") {
      if (!keys(links, ["state", "items"]) || !Array.isArray(links.items)) return null;
      const items = [];
      for (const link of links.items) {
        if (!record(link) || !keys(link, ["id", "serviceName", "toothCode", "caseSite", "current"])) return null;
        const current = currentLink(link.current); if (!current) return null;
        items.push({ ...link, current });
      }
      rows.push({ ...item, currentProblem: problem, planLinks: { state: "allowed", items } } as StrategyProjection["rows"][number]);
    } else if (links.state === "restricted" || links.state === "unavailable") {
      // A withheld transport must not carry accidentally disclosed identity.
      if (Object.keys(links).some(key => key !== "state")) return null;
      rows.push({ ...item, currentProblem: problem, planLinks: { state: links.state } } as StrategyProjection["rows"][number]);
    } else return null;
  }
  const decoded = decodeStrategyRevision({ id: raw.revisionId, patientId: raw.patientId, recordedPatientId: raw.recordedPatientId,
    orthoCaseId: raw.orthoCaseId, clinicalCaseId: raw.clinicalCaseId, schemaVersion: raw.schemaVersion, version: raw.version,
    supersedesRevisionId: raw.supersedesRevisionId, recordingContext: raw.recordingContext,
    createdAt: raw.createdAt, createdBy: raw.createdBy, reason: raw.reason,
    rows: rows.map(row => ({ problem: row.problem, objective: row.objective, strategy: row.strategy, rationale: row.rationale,
      planItems: row.planLinks.state === "allowed" ? row.planLinks.items.map(({ id, serviceName, toothCode, caseSite }) => ({ id, serviceName, toothCode, caseSite })) : [] })) }, scope);
  if (!decoded.ok) return null;
  const value = decoded.value;
  return { ...scope, recordedPatientId: value.recordedPatientId, schemaVersion: 1, revisionId: value.id,
    version: value.version, supersedesRevisionId: value.supersedesRevisionId, recordingContext: value.recordingContext,
    createdAt: value.createdAt, createdBy: value.createdBy, reason: value.reason,
    rows: value.rows.map((row, index) => ({ problem: row.problem, objective: row.objective, strategy: row.strategy, rationale: row.rationale,
      currentProblem: rows[index].currentProblem,
      planLinks: rows[index].planLinks.state === "allowed" ? { state: "allowed", items: row.planItems.map((item, itemIndex) => ({ ...item,
        current: (rows[index].planLinks as Extract<StrategyProjection["rows"][number]["planLinks"], { state: "allowed" }>).items[itemIndex].current })) }
        : rows[index].planLinks })) };
}

export function readStrategyResponse(raw: unknown, patientId: number, orthoCaseId: number, selectedRevisionId?: number): StrategyRead | null {
  if (!record(raw) || !keys(raw, ["ok", "state", "patientId", "orthoCaseId", "clinicalCaseId", "recordingContext", "planVisible", "clinicalWritable", "planLinksWritable", "canRevise", "history", "revision", "choices"])
    || raw.ok !== true || raw.patientId !== patientId || raw.orthoCaseId !== orthoCaseId
    || typeof raw.canRevise !== "boolean"
    || typeof raw.planVisible !== "boolean" || typeof raw.clinicalWritable !== "boolean" || typeof raw.planLinksWritable !== "boolean"
    || typeof raw.recordingContext !== "string" || !["current", "retrospective"].includes(raw.recordingContext) || !Array.isArray(raw.history)
    || !record(raw.choices) || !keys(raw.choices, ["problems", "planItems"]) || !Array.isArray(raw.choices.problems) || !Array.isArray(raw.choices.planItems)) return null;
  if ((raw.planLinksWritable && (!raw.planVisible || !raw.clinicalWritable)) || (raw.canRevise && !raw.clinicalWritable)) return null;
  if (raw.state === "bridge_missing") {
    if (raw.canRevise || raw.clinicalCaseId !== null || raw.revision !== null || raw.history.length || raw.choices.problems.length || raw.choices.planItems.length || selectedRevisionId !== undefined) return null;
    return { ok: true, state: "bridge_missing", patientId, orthoCaseId, clinicalCaseId: null,
      recordingContext: raw.recordingContext as "current" | "retrospective", planVisible: raw.planVisible,
      clinicalWritable: raw.clinicalWritable, planLinksWritable: raw.planLinksWritable, canRevise: false, history: [], revision: null, choices: { problems: [], planItems: [] } };
  }
  if (raw.state !== "ready" || !id(raw.clinicalCaseId)) return null;
  const scope = { patientId, orthoCaseId, clinicalCaseId: raw.clinicalCaseId };
  const revision = raw.revision === null ? null : readStrategyProjection(raw.revision, scope);
  if ((raw.revision !== null && !revision) || (selectedRevisionId !== undefined && revision?.revisionId !== selectedRevisionId)) return null;
  if (!raw.planVisible && revision?.rows.some(row => row.planLinks.state === "allowed")) return null;
  const history: StrategyRead["history"] = [];
  for (const entry of raw.history) {
    if (!record(entry) || !keys(entry, ["revisionId", "version", "recordedPatientId", "supersedesRevisionId", "recordingContext", "createdAt", "createdBy", "reason"])
      || !id(entry.revisionId) || !id(entry.version) || !id(entry.recordedPatientId)
      || !(entry.supersedesRevisionId === null || id(entry.supersedesRevisionId))
      || typeof entry.recordingContext !== "string" || !["current", "retrospective"].includes(entry.recordingContext)
      || !text(entry.createdAt) || !Number.isFinite(Date.parse(entry.createdAt)) || !text(entry.createdBy) || !text(entry.reason)) return null;
    history.push({ revisionId: entry.revisionId, version: entry.version, recordedPatientId: entry.recordedPatientId,
      supersedesRevisionId: entry.supersedesRevisionId, recordingContext: entry.recordingContext as "current" | "retrospective",
      createdAt: entry.createdAt, createdBy: entry.createdBy, reason: entry.reason });
  }
  if ((revision && !history.some(entry => entry.revisionId === revision.revisionId)) || (!revision && history.length)) return null;
  const problems: StrategyRead["choices"]["problems"] = [];
  for (const row of raw.choices.problems) {
    if (!record(row) || !keys(row, ["id", "patientId", "caseId", "label", "site", "status"]) || !id(row.id) || row.patientId !== patientId || row.caseId !== scope.clinicalCaseId
      || !text(row.label) || !optionalText(row.site) || !optionalText(row.status)) return null;
    problems.push({ id: row.id, patientId, caseId: scope.clinicalCaseId, label: row.label, site: row.site, status: row.status });
  }
  const planItems: StrategyRead["choices"]["planItems"] = [];
  if (!raw.planVisible && raw.choices.planItems.length) return null;
  for (const row of raw.choices.planItems) {
    if (!record(row) || !keys(row, ["id", "patientId", "caseId", "serviceName", "toothCode", "caseSite", "status"]) || !id(row.id) || row.patientId !== patientId || row.caseId !== scope.clinicalCaseId
      || !text(row.serviceName) || !(row.toothCode === null || id(row.toothCode)) || !optionalText(row.caseSite) || !optionalText(row.status)) return null;
    planItems.push({ id: row.id, patientId, caseId: scope.clinicalCaseId, serviceName: row.serviceName, toothCode: row.toothCode, caseSite: row.caseSite, status: row.status });
  }
  return { ok: true, state: "ready", ...scope, recordingContext: raw.recordingContext as "current" | "retrospective",
    planVisible: raw.planVisible, clinicalWritable: raw.clinicalWritable, planLinksWritable: raw.planLinksWritable, canRevise: raw.canRevise,
    history, revision, choices: { problems, planItems } };
}

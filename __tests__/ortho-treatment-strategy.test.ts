import { describe, expect, it } from "vitest";
import {
  bindStrategyRows, checkStrategyCommand, decodeStrategyRevision, projectStrategyRevision, strategyScope,
  type StrategyCanonicalContext, type StrategyCommand, type StrategyRevision,
} from "../lib/ortho-treatment-strategy";

// Pure synthetic fixtures only. No server, network, filesystem, database or
// clinical recommendation engine is imported by this contract preparation.
const context = (): StrategyCanonicalContext => ({
  patientId: 1, orthoCase: { id: 2, patientId: 1 }, clinicalCase: { id: 3, patientId: 1, orthoCaseId: 2 },
  problems: [{ id: 4, patientId: 1, caseId: 3, label: "مشكلة تجريبية", site: null, status: "active" }],
  problemLookupState: "ready",
  planItems: [{ id: 5, patientId: 1, caseId: 3, serviceName: "بند تجريبي", toothCode: 16, caseSite: null, status: "in_progress" }],
  planVisibility: "allowed", clinicalWriteAllowed: true, planLinksWritable: true,
});
const command = (): StrategyCommand => ({ schemaVersion: 1, commandId: "synthetic-command-0001", expectedRevisionId: null,
  reason: "مراجعة تجريبية", rows: [{ problemId: 4, objective: "هدف كتبه الطبيب", strategy: "خطة كتبها الطبيب",
    planItemIds: [5], rationale: null }] });
function revision(): StrategyRevision {
  const bound = bindStrategyRows(command(), context(), null);
  if (!bound.ok) throw new Error(bound.code);
  return { id: 7, patientId: 1, recordedPatientId: 1, orthoCaseId: 2, clinicalCaseId: 3, schemaVersion: 1, version: 1,
    recordingContext: "current",
    supersedesRevisionId: null, createdAt: "2026-10-10T00:00:00.000Z", createdBy: "synthetic-clinician",
    reason: "مراجعة تجريبية", rows: bound.value };
}
const errorCode = (result: { ok: true } | { ok: false; code: string }) => result.ok ? null : result.code;

describe("strict clinician-authored strategy command", () => {
  it("preserves free text and returns independently owned arrays", () => {
    const input = command(); input.rows[0].strategy = "  نص حر؛ غير محسوم بعد  ";
    const result = checkStrategyCommand(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows[0].strategy).toBe("نص حر؛ غير محسوم بعد");
    result.value.rows[0].planItemIds.push(6);
    expect(input.rows[0].planItemIds).toEqual([5]);
  });
  it("keeps missing objectives/mechanics missing, without normal or completed defaults", () => {
    const input = command(); input.rows[0] = { ...input.rows[0], objective: "   ", strategy: null, rationale: "", planItemIds: [] };
    const result = checkStrategyCommand(input);
    expect(result).toEqual({ ok: true, value: { ...input, rows: [{ problemId: 4, objective: null, strategy: null, rationale: null, planItemIds: [] }] } });
  });
  it.each(["patientId", "recordedPatientId", "orthoCaseId", "createdBy", "version", "status", "invoiceId", "price"])("rejects supplied %s authority", (key) => {
    expect(errorCode(checkStrategyCommand({ ...command(), [key]: 1 }))).toBe("invalid_command");
  });
  it.each([null, [], "text", 1, new Date()])("rejects non-command shape", (raw) => {
    expect(errorCode(checkStrategyCommand(raw))).toBe("invalid_command");
  });
  it.each([0, -1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1])("rejects malformed problem identity %s", (problemId) => {
    const input = command();
    expect(errorCode(checkStrategyCommand({ ...input, rows: [{ ...input.rows[0], problemId }] }))).toBe("invalid_row");
  });
  it.each([
    { planItemIds: [5, 5] }, { planItemIds: [0] }, { planItemIds: ["5"] },
    { planItemIds: Array.from({ length: 9 }, (_, index) => index + 1) },
  ])("rejects invalid item references $planItemIds", ({ planItemIds }) => {
    const input = command();
    expect(errorCode(checkStrategyCommand({ ...input, rows: [{ ...input.rows[0], planItemIds }] }))).toBe("invalid_item_links");
  });
  it("rejects missing keys and clinical-text truncation rather than dropping input", () => {
    const input = command();
    expect(errorCode(checkStrategyCommand({ ...input, rows: [{ problemId: 4 }] }))).toBe("invalid_row");
    expect(errorCode(checkStrategyCommand({ ...input, rows: [{ ...input.rows[0], objective: "س".repeat(1001) }] }))).toBe("invalid_text");
    expect(errorCode(checkStrategyCommand({ ...input, reason: " " }))).toBe("reason_required");
    expect(errorCode(checkStrategyCommand({ ...input, expectedRevisionId: "7" }))).toBe("invalid_revision");
    expect(errorCode(checkStrategyCommand({ ...input, commandId: "bad" }))).toBe("invalid_command_id");
    expect(errorCode(checkStrategyCommand({ ...input, schemaVersion: 2 }))).toBe("unsupported_schema");
  });
  it("bounds row count and permits deliberate separate objectives for one known problem", () => {
    const input = command();
    expect(errorCode(checkStrategyCommand({ ...input, rows: [] }))).toBe("invalid_rows");
    expect(errorCode(checkStrategyCommand({ ...input, rows: Array.from({ length: 31 }, () => input.rows[0]) }))).toBe("invalid_rows");
    expect(checkStrategyCommand({ ...input, rows: [input.rows[0], { ...input.rows[0], objective: "هدف آخر كتبه الطبيب" }] }).ok).toBe(true);
  });
});

describe("canonical case binding without new entities or financial state", () => {
  it("requires an actual same-patient Ortho bridge, never a funding plan inference", () => {
    const c = context(); c.clinicalCase = null;
    expect(errorCode(strategyScope(c))).toBe("bridge_missing");
    expect(errorCode(strategyScope({ ...context(), orthoCase: { id: 2, patientId: 99 } }))).toBe("scope_mismatch");
    expect(errorCode(strategyScope({ ...context(), clinicalCase: { id: 3, patientId: 1, orthoCaseId: 22 } }))).toBe("scope_mismatch");
  });
  it.each(["missing", "foreign", "other-case", "duplicate"])("rejects %s problem without dropping its link", (kind) => {
    const c = context();
    c.problems = kind === "missing" ? [] : kind === "duplicate" ? [c.problems[0], c.problems[0]]
      : [{ ...c.problems[0], ...(kind === "foreign" ? { patientId: 99 } : { caseId: 33 }) }];
    expect(errorCode(bindStrategyRows(command(), c, null))).toBe("problem_scope_mismatch");
  });
  it.each(["missing", "foreign", "unlinked", "other-case", "duplicate"])("rejects %s plan item without guessing ownership", (kind) => {
    const c = context();
    c.planItems = kind === "missing" ? [] : kind === "duplicate" ? [c.planItems[0], c.planItems[0]]
      : [{ ...c.planItems[0], ...(kind === "foreign" ? { patientId: 99 } : { caseId: kind === "unlinked" ? null : 33 }) }];
    expect(errorCode(bindStrategyRows(command(), c, null))).toBe("item_scope_mismatch");
  });
  it("uses exact clinical membership across plans, without comparing funding planId", () => {
    const c = context();
    const joinedItems = [{ ...c.planItems[0], planId: 11, unitPriceMinor: 9999 },
      { ...c.planItems[0], id: 6, planId: 12, serviceName: "بند من خطة أخرى", unitPriceMinor: 5555 }];
    c.planItems = joinedItems;
    const input = command(); input.rows[0].planItemIds = [5, 6];
    const result = bindStrategyRows(input, c, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0].planItems.map((item) => item.id)).toEqual([5, 6]);
    expect(result.value[0]).not.toHaveProperty("status");
    expect(JSON.stringify(result.value)).not.toMatch(/price|invoice|currency|completed|clearance/);
  });
  it("requires the exact latest revision while retaining old revision bytes", () => {
    const saved = revision(), before = JSON.stringify(saved), input = command();
    expect(errorCode(bindStrategyRows(input, context(), saved))).toBe("stale_revision");
    input.expectedRevisionId = saved.id;
    expect(bindStrategyRows(input, context(), saved).ok).toBe(true);
    expect(errorCode(bindStrategyRows(input, context(), { ...saved, patientId: 99 }))).toBe("revision_scope_mismatch");
    expect(JSON.stringify(saved)).toBe(before);
  });
  it("does not use empty replacement links to evade revoked plan permission", () => {
    const saved = revision(), input = command(); input.expectedRevisionId = saved.id; input.rows[0].planItemIds = [];
    expect(errorCode(bindStrategyRows(input, { ...context(), planLinksWritable: false }, saved))).toBe("plan_links_unavailable");
    expect(errorCode(bindStrategyRows(command(), { ...context(), planVisibility: "restricted" }, null))).toBe("plan_links_unavailable");
  });
  it("allows unlinked clinical text without plan edit authority, but never without clinical edit access", () => {
    const input = command(); input.rows[0].planItemIds = [];
    expect(bindStrategyRows(input, { ...context(), planVisibility: "restricted", planLinksWritable: false }, null).ok).toBe(true);
    expect(errorCode(bindStrategyRows(input, { ...context(), clinicalWriteAllowed: false }, null))).toBe("clinical_edit_denied");
  });
  it("refuses an unavailable problem lookup rather than treating it as an empty valid list", () => {
    expect(errorCode(bindStrategyRows(command(), { ...context(), problems: [], problemLookupState: "unavailable" }, null)))
      .toBe("problems_unavailable");
  });
});

describe("one immutable clinical projection for visits and export", () => {
  it("preserves authored snapshots when live labels change and does not mutate either source", () => {
    const saved = revision(), c = context(); c.problems = [{ ...c.problems[0], label: "اسم حالي آخر", status: "inactive" }];
    const before = JSON.stringify({ saved, c });
    const result = projectStrategyRevision(saved, c);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value).toMatchObject({ schemaVersion: 1, revisionId: 7, version: 1, supersedesRevisionId: null });
    expect(result.value.rows[0].problem.label).toBe("مشكلة تجريبية");
    expect(result.value.rows[0].currentProblem).toEqual({ state: "available", status: "inactive" });
    result.value.rows[0].problem.label = "تعديل نسخة العرض";
    expect(JSON.stringify({ saved, c })).toBe(before);
  });
  it.each(["cancelled", "in_progress", "waiting", "unknown-status", null])("does not turn %s into completion or clearance", (status) => {
    const c = context(); c.planItems = [{ ...c.planItems[0], status }];
    const result = projectStrategyRevision(revision(), c);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.rows[0].planLinks).toMatchObject({ state: "allowed", items: [{ current: { state: "available", status } }] });
    expect(result.value.rows[0]).not.toHaveProperty("completed");
    expect(result.value.rows[0]).not.toHaveProperty("clearance");
  });
  it.each(["restricted", "unavailable"] as const)("redacts all historic plan identity and tooth data when %s", (planVisibility) => {
    const result = projectStrategyRevision(revision(), { ...context(), planVisibility });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.rows[0].planLinks).toEqual({ state: planVisibility });
    expect(JSON.stringify(result.value)).not.toContain("بند تجريبي");
    expect(JSON.stringify(result.value)).not.toContain("toothCode");
  });
  it.each(["missing", "moved", "foreign"])("keeps old identity but labels current %s reference safely", (kind) => {
    const c = context(); c.planItems = kind === "missing" ? [] : [{ ...c.planItems[0], serviceName: "بيان لا يجوز تسريبه",
      ...(kind === "foreign" ? { patientId: 99 } : { caseId: 33 }) }];
    const result = projectStrategyRevision(revision(), c);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.rows[0].planLinks).toMatchObject({ state: "allowed", items: [{ serviceName: "بند تجريبي",
      current: { state: kind === "foreign" ? "unavailable" : kind, status: null } }] });
    expect(JSON.stringify(result.value)).not.toContain("بيان لا يجوز تسريبه");
  });
  it("refuses foreign selected revision rather than falling back to another case", () => {
    expect(errorCode(projectStrategyRevision({ ...revision(), orthoCaseId: 99 }, context()))).toBe("revision_scope_mismatch");
  });
  it("labels a failed current-problem lookup as unavailable, never missing/resolved", () => {
    const result = projectStrategyRevision(revision(), { ...context(), problems: [], problemLookupState: "unavailable" });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value.rows[0].currentProblem).toEqual({ state: "unavailable", status: null });
  });
});

describe("strict stored revision admission before projection", () => {
  const scope = { patientId: 1, orthoCaseId: 2, clinicalCaseId: 3 };
  it("preserves exact authored history and creates no aliases to stored arrays", () => {
    const saved = revision(); saved.rows[0].strategy = " نص محفوظ كما كُتب ";
    const decoded = decodeStrategyRevision(saved, scope);
    expect(decoded).toEqual({ ok: true, value: saved });
    if (!decoded.ok) return;
    decoded.value.rows[0].problem.label = "تغيير في نسخة القراءة";
    expect(saved.rows[0].problem.label).toBe("مشكلة تجريبية");
  });
  it("retains explicitly labelled retrospective documentation without deriving case or item mutations", () => {
    const saved = revision(); saved.recordingContext = "retrospective";
    const decoded = decodeStrategyRevision(saved, scope);
    expect(decoded.ok).toBe(true); if (!decoded.ok) return;
    const projected = projectStrategyRevision(decoded.value, context());
    expect(projected.ok).toBe(true); if (!projected.ok) return;
    expect(projected.value.recordingContext).toBe("retrospective");
    expect(projected.value).not.toHaveProperty("caseStatus");
    expect(projected.value).not.toHaveProperty("performed");
  });
  it("keeps original identity separate from current canonical ownership after an explicit merge", () => {
    const saved = revision(); const recordedBytes = JSON.stringify(saved);
    const moved = { ...saved, patientId: 9 }; const movedBytes = JSON.stringify(moved);
    const current = context(); current.patientId = 9; current.orthoCase.patientId = 9;
    current.clinicalCase!.patientId = 9;
    current.problems = current.problems.map(row => ({ ...row, patientId: 9 }));
    current.planItems = current.planItems.map(row => ({ ...row, patientId: 9 }));
    const decoded = decodeStrategyRevision(moved, { patientId: 9, orthoCaseId: 2, clinicalCaseId: 3 });
    expect(decoded.ok).toBe(true); if (!decoded.ok) return;
    const projected = projectStrategyRevision(decoded.value, current);
    expect(projected.ok).toBe(true); if (!projected.ok) return;
    expect(projected.value).toMatchObject({ patientId: 9, recordedPatientId: 1, createdBy: saved.createdBy, reason: saved.reason });
    // Decoder key insertion order is not clinical data. Every value and array
    // order must match; neither the original record nor its moved view may change.
    expect(decoded.value).toStrictEqual(moved);
    expect(errorCode(decodeStrategyRevision(moved, scope))).toBe("invalid_stored_revision");
    expect(errorCode(projectStrategyRevision(decoded.value, context()))).toBe("revision_scope_mismatch");
    current.clinicalCase!.patientId = 1;
    expect(errorCode(projectStrategyRevision(decoded.value, current))).toBe("scope_mismatch");
    expect(JSON.stringify(saved)).toBe(recordedBytes);
    expect(JSON.stringify(moved)).toBe(movedBytes);
  });
  it.each([undefined, null, 0, -1, "1"])("rejects invalid recording provenance %s without authorizing through it", recordedPatientId => {
    expect(errorCode(decodeStrategyRevision({ ...revision(), recordedPatientId }, scope))).toBe("invalid_stored_revision");
  });
  it.each(["foreign", "schema", "lineage", "context", "timestamp", "empty", "row-text", "item-finance", "duplicate", "extra"])(
    "rejects %s stored history explicitly without an empty/normal fallback", (kind) => {
      const raw = revision() as unknown as Record<string, unknown>;
      if (kind === "foreign") raw.patientId = 99;
      if (kind === "schema") raw.schemaVersion = 2;
      if (kind === "lineage") raw.supersedesRevisionId = 8;
      if (kind === "context") raw.recordingContext = "completed";
      if (kind === "timestamp") raw.createdAt = "not a timestamp";
      if (kind === "empty") raw.rows = [];
      if (kind === "row-text") raw.rows = [{ ...revision().rows[0], objective: { normal: true } }];
      if (kind === "item-finance") raw.rows = [{ ...revision().rows[0], planItems: [{ ...revision().rows[0].planItems[0], price: 100 }] }];
      if (kind === "duplicate") raw.rows = [{ ...revision().rows[0], planItems: [revision().rows[0].planItems[0], revision().rows[0].planItems[0]] }];
      if (kind === "extra") raw.finance = { amount: 100 };
      const result = decodeStrategyRevision(raw, scope);
      expect(errorCode(result)).toBe("invalid_stored_revision");
      expect(result).not.toHaveProperty("value");
    });
});

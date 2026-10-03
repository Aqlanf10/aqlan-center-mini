import { describe, expect, it } from "vitest";
import { SPECIALTIES, SPECIALTY_LABEL } from "../lib/appointment-services";
import { SPECIALTY_WORKSPACES, readSpecialtyContext, specialtyCaseFocus, specialtyPlanItemFocus, specialtyVisitWorkFocus } from "../lib/patient-specialty-workspaces";
import { WORKSPACE_SECTIONS } from "../lib/patient-workspace-navigation";

const savedCase = (id = 5, patientId = 91) => ({ id, kind: "specialty", orthoCaseId: null, patientId,
  specialty: "endodontics", title: "Synthetic roots case", site: "36", problem: "Synthetic clinical problem", responsibleName: "Responsible case provider",
  status: "active", startedOn: "2026-10-03", outcome: null, itemsTotal: 700, itemsDone: 600, totalMinor: 123456 });
const item = (id = 41, caseId: number | null = 5) => ({ id, planId: 31, planTitle: "Synthetic master plan", serviceName: "Synthetic planned service", toothCode: 36,
  status: "planned", doctorName: "Assigned item provider", caseId, priority: null, sortOrder: 0, totalMinor: 999999, category: "rct" });
const payload = () => ({ cases: [savedCase()], problems: [], planVisible: true, items: [item()], dependencies: [] });
const ortho = () => ({ ...savedCase(), id: null, kind: "ortho", specialty: "orthodontics", orthoCaseId: 9 });

describe("reconstructed specialty presentation registry", () => {
  it("uses the authoritative 13 vocabularies once, keeping aliases inside the canonical entry", () => {
    expect(SPECIALTY_WORKSPACES.map((row) => row.id)).toEqual(SPECIALTIES);
    expect(new Set(SPECIALTY_WORKSPACES.map((row) => row.id)).size).toBe(13);
    for (const row of SPECIALTY_WORKSPACES) {
      expect(row.label).toBe(SPECIALTY_LABEL[row.id]);
      expect(WORKSPACE_SECTIONS.some((section) => section.id === row.destination)).toBe(true);
      expect(row.description.length).toBeGreaterThan(10); expect(row.gap.length).toBeGreaterThan(10);
    }
    expect(SPECIALTY_WORKSPACES.filter((row) => row.kind === "dedicated").map((row) => row.id)).toEqual(["orthodontics", "endodontics", "periodontics"]);
    expect(SPECIALTY_WORKSPACES.find((row) => row.id === "endodontics")?.aliases).toEqual(expect.arrayContaining(["علاج العصب", "علاج عصب", "جذور"]));
  });
  it.each(SPECIALTIES)("accepts the saved %s vocabulary without creating a new clinical model", (specialty) => {
    expect(readSpecialtyContext({ ...payload(), cases: [{ ...savedCase(), specialty }] }, 91).cases[0].specialty).toBe(specialty);
  });
});

describe("strict specialty context allowlist", () => {
  it("reads canonical identity and separate provider labels without storing prices or case-derived plan totals", () => {
    const value = readSpecialtyContext(payload(), 91);
    expect(value.cases[0].responsibleName).toBe("Responsible case provider");
    expect(value.items[0].doctorName).toBe("Assigned item provider");
    expect(JSON.stringify(value)).not.toMatch(/totalMinor|itemsTotal|itemsDone|category|priority|sortOrder/);
  });
  it("keeps required identity strict but does not invent requirements for unused canonical fields", () => {
    const value = readSpecialtyContext(payload(), 91);
    expect(value.cases[0].waitingOn).toEqual([]);
    expect(value.cases[0]).not.toHaveProperty("responsiblePartyId");
    expect(value.cases[0]).not.toHaveProperty("createdBy");
  });
  it("strips hidden items/dependencies and case-derived totals, even if the server mistakenly supplied them", () => {
    const value = readSpecialtyContext({ ...payload(), planVisible: false, items: [{ ...item(), serviceName: "PRIVATE ITEM" }], dependencies: [{ note: "PRIVATE DEPENDENCY" }], planTotalMinor: 888 }, 91);
    expect(value.items).toEqual([]); expect(value.dependencies).toEqual([]);
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|itemsTotal|itemsDone|planTotal|888|999999/);
  });
  it("does not parse hidden bodies or infer a missing permission as permission", () => {
    const hidden = { cases: [savedCase()], problems: [], planVisible: false };
    Object.defineProperty(hidden, "items", { get() { throw new Error("must not inspect hidden items"); } });
    Object.defineProperty(hidden, "dependencies", { get() { throw new Error("must not inspect hidden dependencies"); } });
    expect(readSpecialtyContext(hidden, 91).planVisible).toBe(false);
    const missing = payload() as Record<string, unknown>; delete missing.planVisible;
    expect(() => readSpecialtyContext(missing, 91)).toThrow();
  });
  it.each([
    {}, { ...payload(), cases: null }, { ...payload(), patientId: 92 }, { ...payload(), planVisible: "true" },
    { ...payload(), cases: [savedCase(5, 92)] }, { ...payload(), cases: [savedCase(), savedCase()] },
    { ...payload(), cases: [{ ...savedCase(), id: null }] }, { ...payload(), cases: [{ ...savedCase(), specialty: "endo" }] },
    { ...payload(), cases: [{ ...savedCase(), kind: "ortho", id: 5, orthoCaseId: 9 }] },
    { ...payload(), cases: [{ ...ortho(), orthoCaseId: null }] },
    { ...payload(), items: [item(), item()] }, { ...payload(), items: [{ ...item(), patientId: 92 }] },
    { ...payload(), items: [{ ...item(), caseId: 9 }] }, { ...payload(), items: [{ ...item(), caseId: undefined }] },
    { ...payload(), items: [{ ...item(), planId: null }] }, { ...payload(), items: [{ ...item(), toothCode: 99 }] },
    { ...payload(), items: [{ ...item(), toothCode: undefined }] }, { ...payload(), dependencies: undefined },
  ])("rejects incomplete/foreign/duplicate associations instead of turning them into empty success: %j", (value) => {
    expect(() => readSpecialtyContext(value, 91)).toThrow();
  });
  it("keeps a native Ortho id separate from saved case identity, including numerical collisions", () => {
    const value = readSpecialtyContext({ ...payload(), cases: [ortho(), savedCase(9)], items: [item(41, null)] }, 91);
    expect(value.cases[0]).toMatchObject({ id: null, kind: "ortho", orthoCaseId: 9 });
    expect(specialtyCaseFocus(value, null)).toBeNull();
    expect(specialtyCaseFocus(value, 9)).toEqual({ kind: "case", patientId: 91, caseId: 9 });
    expect(value.items[0].caseId).toBeNull();
  });
  it("rejects both a bridged and unbridged projection of the same native Ortho record", () => {
    expect(() => readSpecialtyContext({ ...payload(), cases: [ortho(), { ...savedCase(), specialty: "orthodontics", orthoCaseId: 9 }] }, 91)).toThrow();
  });
  it("preserves exact problem-case links and rejects another patient's/unknown case problems", () => {
    const problem = { id: 7, patientId: 91, label: "Synthetic problem", site: null, specialty: null, status: "active", caseId: 5, caseTitle: "unused" };
    expect(readSpecialtyContext({ ...payload(), problems: [problem] }, 91).problems[0]).toMatchObject({ caseId: 5, specialty: null });
    for (const invalid of [{ ...problem, patientId: 92 }, { ...problem, caseId: 9 }, { ...problem, caseId: undefined }]) {
      expect(() => readSpecialtyContext({ ...payload(), problems: [invalid] }, 91)).toThrow();
    }
    expect(() => readSpecialtyContext({ ...payload(), problems: [problem, problem] }, 91)).toThrow();
  });
  it("validates both dependency ends in this patient's projection and keeps cross-case links exact", () => {
    const dependent = item(), required = { ...item(42, 6), planId: 32, toothCode: 46, status: "in_progress" };
    const dependency = { itemId: 41, requiresItemId: 42, requirement: "clearance", met: true, note: "Recorded clearance requirement" };
    const data = { ...payload(), cases: [savedCase(), { ...savedCase(6), specialty: "surgery" }], items: [dependent, required], dependencies: [dependency] };
    const value = readSpecialtyContext(data, 91);
    expect(value.dependencies).toEqual([dependency]);
    expect(specialtyPlanItemFocus(value, value.items[1])).toEqual({ kind: "plan_item", patientId: 91, planId: 32, itemId: 42, caseId: 6, toothCode: 46 });
    for (const wrong of [{ ...dependency, requiresItemId: 999 }, { ...dependency, itemId: 999 }, { ...dependency, requiresItemId: 41 },
      { ...dependency, met: false }, { ...dependency, requirement: "unknown" }, { ...dependency, patientId: 92 }]) {
      expect(() => readSpecialtyContext({ ...data, dependencies: [wrong] }, 91)).toThrow();
    }
    expect(() => readSpecialtyContext({ ...data, dependencies: [dependency, dependency] }, 91)).toThrow();
  });
});

describe("read-only exact focus builders", () => {
  it("preserves the full saved case/item/plan/tooth and current-visit tuple", () => {
    const value = readSpecialtyContext(payload(), 91);
    expect(specialtyCaseFocus(value, 5)).toEqual({ kind: "case", patientId: 91, caseId: 5 });
    expect(specialtyCaseFocus(value, 500)).toBeNull();
    expect(specialtyPlanItemFocus(value, value.items[0])).toEqual({ kind: "plan_item", patientId: 91, planId: 31, itemId: 41, caseId: 5, toothCode: 36 });
    expect(specialtyVisitWorkFocus(value, value.items[0], 21)).toEqual({ kind: "visit_work", patientId: 91, visitId: 21, planId: 31, itemId: 41, caseId: 5, toothCode: 36 });
  });
  it("represents an actual unlinked item and no-tooth explicitly for visit review, never selecting the first case", () => {
    const value = readSpecialtyContext({ ...payload(), items: [{ ...item(41, null), toothCode: null }] }, 91);
    expect(specialtyVisitWorkFocus(value, value.items[0], 21)).toEqual({ kind: "visit_work", patientId: 91, visitId: 21, planId: 31, itemId: 41, caseId: null, toothCode: null });
    expect(specialtyPlanItemFocus(value, value.items[0])).toEqual({ kind: "plan_item", patientId: 91, planId: 31, itemId: 41 });
  });
  it.each(["done", "cancelled", "scheduled", "deferred"])("keeps %s history readable without offering visit review", (status) => {
    const value = readSpecialtyContext({ ...payload(), items: [{ ...item(), status }] }, 91);
    expect(specialtyPlanItemFocus(value, value.items[0])).not.toBeNull();
    expect(specialtyVisitWorkFocus(value, value.items[0], 21)).toBeNull();
  });
  it("does not offer review for no visit, hidden plan, or a changed association", () => {
    const value = readSpecialtyContext(payload(), 91), target = value.items[0];
    for (const changed of [{ ...target, id: 999 }, { ...target, caseId: null }, { ...target, toothCode: 46 }, { ...target, planId: 32 }]) {
      expect(specialtyPlanItemFocus(value, changed)).toBeNull(); expect(specialtyVisitWorkFocus(value, changed, 21)).toBeNull();
    }
    expect(specialtyVisitWorkFocus(value, target, null)).toBeNull(); expect(specialtyVisitWorkFocus(value, target, 0)).toBeNull();
    const hidden = { ...value, planVisible: false };
    expect(specialtyPlanItemFocus(hidden, target)).toBeNull(); expect(specialtyVisitWorkFocus(hidden, target, 21)).toBeNull();
  });
});

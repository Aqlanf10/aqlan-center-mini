import { describe, expect, it } from "vitest";
import { isCanonicalPatientCases, type CanonicalPatientCases } from "../lib/canonical-case-projection";

const fixture = (): CanonicalPatientCases => ({ projection: "patient-cases-clinical", patientId: 1, planVisible: true, orthoVisible: false,
  cases: [{ id: 2, kind: "specialty", orthoCaseId: null, specialty: "endodontics", title: "SYN case", site: "26", problem: null, responsibleName: null, status: "active", startedOn: "2024-01-01", completedAt: null, outcome: null }],
  problems: [{ id: 3, label: "SYN problem", site: null, specialty: null, status: "active", caseId: 2, notedBy: "SYN", notedAt: "2024-01-01T00:00:00Z", resolvedBy: null, resolvedAt: null }],
  items: [4, 5].map(id => ({ id, planId: 6, planTitle: "SYN plan", planStatus: "active", serviceName: `SYN ${id}`, category: null, toothCode: null, surfaces: null, status: id === 5 ? "done" : "planned", doctorName: null, caseId: 2, priority: null, sortOrder: 0 })),
  dependencies: [{ itemId: 4, requiresItemId: 5, requirement: "completed", note: null, met: true, createdBy: "SYN", version: "a".repeat(64) }],
});
describe("clinical case allowlist and graph", () => {
  it("accepts saved clinical facts and complete endpoints", () => expect(isCanonicalPatientCases(fixture(), 1)).toBe(true));
  it.each(["root", "case", "problem", "item", "dependency"])("refuses extra %s fields including accidental financial expansions", group => {
    const body = fixture(), target = group === "root" ? body : group === "case" ? body.cases[0] : group === "problem" ? body.problems[0] : group === "item" ? body.items[0] : body.dependencies[0];
    Object.assign(target, { invoiceId: 123 }); expect(isCanonicalPatientCases(body, 1)).toBe(false);
  });
  it.each(["missing-endpoint", "cycle", "duplicate-edge", "false-progress", "wrong-patient", "missing-case", "hidden-plan", "hidden-ortho", "invalid-date"])("rejects %s", kind => {
    const body = fixture();
    if (kind === "missing-endpoint") body.dependencies[0].requiresItemId = 99;
    if (kind === "cycle") body.dependencies.push({ ...body.dependencies[0], itemId: 5, requiresItemId: 4, met: false });
    if (kind === "duplicate-edge") body.dependencies.push({ ...body.dependencies[0] });
    if (kind === "false-progress") body.dependencies[0].met = false;
    if (kind === "wrong-patient") body.patientId = 2;
    if (kind === "missing-case") body.items[0].caseId = 99;
    if (kind === "hidden-plan") body.planVisible = false;
    if (kind === "hidden-ortho") body.cases[0] = { ...body.cases[0], specialty: "orthodontics", orthoCaseId: 9 };
    if (kind === "invalid-date") body.cases[0].startedOn = "2024-02-31";
    expect(isCanonicalPatientCases(body, 1)).toBe(false);
  });
  it("accepts a legitimately empty care projection without plan access", () => expect(isCanonicalPatientCases({ ...fixture(), cases: [], problems: [], items: [], dependencies: [], planVisible: false }, 1)).toBe(true));
  it.each(["", "a".repeat(63), "X".repeat(64)])("refuses malformed dependency version %s", version => { const body = fixture(); body.dependencies[0].version = version; expect(isCanonicalPatientCases(body, 1)).toBe(false); });
});

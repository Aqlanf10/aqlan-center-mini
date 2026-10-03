import { describe, expect, it } from "vitest";
import { resolvePlanItemFocus } from "../lib/patient-workspace-focus";
import { SPECIALTY_WORKSPACES } from "../lib/patient-specialty-workspaces";

describe("read-only focus history and specialty naming", () => {
  it("routes the one periodontal entry to the dedicated persisted workspace, without claiming clinical completion", () => {
    const entries = SPECIALTY_WORKSPACES.filter((row) => row.id === "periodontics");
    expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ destination: "perio", kind: "dedicated" });
    expect(entries[0].gap).toContain("التحقق الكامل");
  });
  it("names cancelled-item history limitation separately from an absent record", () => {
    const focus = { kind: "plan_item" as const, patientId: 91, planId: 20, itemId: 4 };
    const cancelled = { id: 4, status: "cancelled", toothCode: 36 };
    expect(resolvePlanItemFocus(91, focus, [{ id: 20, patientId: 91, items: [cancelled] }])).toEqual({ status: "unavailable", reason: "history_unavailable" });
    expect(resolvePlanItemFocus(91, focus, [{ id: 20, patientId: 91, items: [] }])).toEqual({ status: "unavailable", reason: "missing" });
  });
  it("does not hide duplicate identity by filtering out one cancelled version", () => {
    expect(resolvePlanItemFocus(91, { kind: "plan_item", patientId: 91, planId: 20, itemId: 4 }, [{ id: 20, patientId: 91, items: [
      { id: 4, status: "cancelled", toothCode: 36 }, { id: 4, status: "planned", toothCode: 36 },
    ] }])).toEqual({ status: "unavailable", reason: "missing" });
  });
  it("keeps all nerve/root-canal aliases on the one canonical endodontics entry", () => {
    const entries = SPECIALTY_WORKSPACES.filter((row) => row.id === "endodontics");
    expect(entries).toHaveLength(1);
    expect(entries[0].aliases).toEqual(expect.arrayContaining(["علاج العصب", "علاج عصب", "جذور"]));
    expect(entries[0].destination).toBe("endo");
    expect(SPECIALTY_WORKSPACES.some((row) => String(row.id) === "endo" || String(row.id) === "nerve")).toBe(false);
  });
});

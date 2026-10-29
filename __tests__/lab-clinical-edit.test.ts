import { describe, expect, it } from "vitest";
import { labClinicalEditProblem, parseLabClinicalSnapshot, sameLabClinicalSnapshot, type LabClinicalSnapshot } from "../lib/lab-clinical-edit";
const previous: LabClinicalSnapshot = { doctorId: null, workType: "طقم جزئي", toothNumbers: "11 (crown)", shade: "OM3", shadeSpecification: null, partyId: null, labName: "Synthetic legacy lab", labPhone: null };
describe("explicit clinical corrections", () => {
  it("reads historical roles and legacy shades without silently correcting them", () => {
    expect(parseLabClinicalSnapshot(previous)).toEqual(previous);
    expect(labClinicalEditProblem(previous, previous)).toBeTruthy();
    expect(previous.toothNumbers).toBe("11 (crown)");
  });
  it("requires explicit correct doctor and denture role but preserves unchanged legacy shade", () => {
    const next = { ...previous, doctorId: 12, toothNumbers: "11 (denture_tooth)" };
    expect(labClinicalEditProblem(next, previous)).toBeNull();
    expect(labClinicalEditProblem({ ...next, shade: "BL9" }, previous)).toBeTruthy();
    expect(labClinicalEditProblem({ ...next, shade: "0M3" }, previous)).toBeNull();
  });
  it("uses strict snapshots and detects changed individual fields", () => {
    expect(parseLabClinicalSnapshot({ ...previous, costMinor: 100 })).toBeNull();
    expect(parseLabClinicalSnapshot({ ...previous, partyId: "12" })).toBeNull();
    expect(sameLabClinicalSnapshot(previous, { ...previous })).toBe(true);
    for (const update of [{ doctorId: 12 }, { toothNumbers: "12" }, { shade: "A2" }, { labPhone: "123" }]) expect(sameLabClinicalSnapshot(previous, { ...previous, ...update })).toBe(false);
  });
});

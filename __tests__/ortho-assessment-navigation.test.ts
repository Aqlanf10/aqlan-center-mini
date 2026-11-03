import { describe, expect, it, vi } from "vitest";
import { assessmentBookmark, assessmentNeighbour, readAssessmentBookmark, replaceAssessmentBookmark } from "../lib/ortho-assessment-navigation";
describe("case-scoped assessment bookmarks", () => {
  it("orders measurements before radiographs and ceph without creating a linear clinical gate", () => {
    expect(assessmentNeighbour("interview", -1)).toBeNull();
    expect(assessmentNeighbour("intraoral", 1)).toBe("measurements");
    expect(assessmentNeighbour("measurements", 1)).toBe("records");
    expect(assessmentNeighbour("comparison", 1)).toBeNull();
  });
  it("round-trips only the intended patient's integer case and known section", () => {
    expect(readAssessmentBookmark(assessmentBookmark(12, 23, "extraoral"), 12)).toEqual({ caseId: 23, section: "extraoral" });
    for (const hash of ["#ortho-assessment/13/23/extraoral", "#ortho-assessment/12/0/interview", "#ortho-assessment/12/2147483648/interview", "#ortho-assessment/12/23/unknown", "#ortho-assessment/12/23/interview?secret=text", "#ortho-assessment/12/23/interview/extra"]) expect(readAssessmentBookmark(hash, 12)).toBeNull();
  });
  it("preserves patient context query, replaces only the current URL and refuses a departed patient", () => {
    const replaceState = vi.fn(), dispatchEvent = vi.fn();
    const host = { location: { pathname: "/patients/12", href: "https://clinic.test/patients/12?tab=treatment&sub=ortho&orthoCaseId=23" }, history: { replaceState }, dispatchEvent } as unknown as Window;
    expect(replaceAssessmentBookmark(host, 12, 23, "intraoral")).toBe(true);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/patients/12?tab=treatment&sub=ortho&orthoCaseId=23#ortho-assessment/12/23/intraoral");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(replaceAssessmentBookmark(host, 99, 23, "interview")).toBe(false);
    expect(replaceState).toHaveBeenCalledTimes(1);
  });
});

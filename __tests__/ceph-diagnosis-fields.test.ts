import { describe, expect, it } from "vitest";
import { fillEmptyCephDiagnosisFields } from "../lib/ceph-diagnosis-fields";
const suggestion = { skeletal: "Generated skeletal", dental: "Generated dental", softTissue: "Generated soft tissue", finalDx: "Generated observation" };
describe("descriptive assistance preserves clinician authorship", () => {
  it("preserves every nonempty field and the exact clinician note", () => {
    const authored = Object.freeze({ skeletal: "My skeletal", dental: "My dental", softTissue: "My profile", finalDx: "My diagnosis", note: "My plan\nDo not replace." });
    expect(fillEmptyCephDiagnosisFields(authored, suggestion)).toEqual(authored);
  });
  it("fills only empty observation fields, never notes, without mutating input", () => {
    const current = Object.freeze({ skeletal: "Existing", dental: "", softTissue: " ", finalDx: "", note: "" });
    expect(fillEmptyCephDiagnosisFields(current, suggestion)).toEqual({ ...suggestion, skeletal: "Existing", note: "" });
    expect(current.dental).toBe("");
  });
});

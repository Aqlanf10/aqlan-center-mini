import { describe, expect, it } from "vitest";
import { parsePatientStatementOptions } from "../lib/patient-statement-options";

describe("patient statement scope is never silently widened", () => {
  it.each(["summary", "detailed", "ongoing", "period"])("rejects treatment selection on %s reports", type => {
    const query = new URLSearchParams({ type, treatmentId: "27" });
    if (type === "period") { query.set("from", "2026-01-01"); query.set("to", "2026-01-31"); }
    expect(() => parsePatientStatementOptions(query, 7)).toThrow("العلاج المحدد متاح في كشف العلاج فقط.");
  });
  it("rejects treatment selection on an implicitly selected date-period report", () => {
    expect(() => parsePatientStatementOptions(new URLSearchParams("from=2026-01-01&to=2026-01-31&treatmentId=27"), 7)).toThrow("العلاج المحدد متاح في كشف العلاج فقط.");
  });
  it("preserves explicit selected-treatment scope", () => {
    expect(parsePatientStatementOptions(new URLSearchParams("type=treatment&treatmentId=27"), 7)).toEqual({ type: "treatment", treatmentId: 27 });
  });
});

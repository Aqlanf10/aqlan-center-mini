import { describe, expect, it } from "vitest";
import { isSameOrthoPillarTransition, samePatientLocation } from "../lib/ortho-pillar-navigation";
import { CLINICAL_CONTEXT_IDS, type PatientLocation } from "../lib/patient-navigation";

const from: PatientLocation = { tab: "treatment", sub: "ortho", context: {
  patientId: 91, orthoCaseId: 123, clinicalCaseId: 456, planId: 31, planItemId: 32, visitId: 41, pillar: "prescription",
} };
const to: PatientLocation = { ...from, context: { ...from.context, pillar: "wires" } };

describe("exact canonical Ortho pillar identity", () => {
  it("permits only the view change, retaining every present and absent clinical edge", () => {
    expect(isSameOrthoPillarTransition(from, to)).toBe(true);
    expect(isSameOrthoPillarTransition(to, from)).toBe(true);
    expect(isSameOrthoPillarTransition({ ...from, context: { patientId: 91, orthoCaseId: 123, pillar: "wires" } },
      { ...to, context: { patientId: 91, orthoCaseId: 123, pillar: "diagnostics" } })).toBe(true);
    expect(isSameOrthoPillarTransition(from, from)).toBe(false);
    expect(samePatientLocation(from, to)).toBe(false);
  });
  it.each(CLINICAL_CONTEXT_IDS)("refuses changing or dropping %s", key => {
    expect(isSameOrthoPillarTransition(from, { ...to, context: { ...to.context, [key]: 987 } })).toBe(false);
    if (from.context![key] !== undefined) {
      const context = { ...to.context }; delete context[key];
      expect(isSameOrthoPillarTransition(from, { ...to, context })).toBe(false);
    }
  });
  it("does not turn an unselected case, other workspace, invalid URL or Endo edge into a grant", () => {
    for (const changed of [
      { ...from, context: undefined }, { ...from, contextError: "invalid_context" as const },
      { ...from, tab: "account" as const }, { ...from, sub: "cases" as const },
      { ...from, context: { ...from.context, orthoCaseId: 0 } },
      { ...from, context: { ...from.context, endoTreatmentId: 12 } },
    ]) expect(isSameOrthoPillarTransition(changed, to)).toBe(false);
    expect(isSameOrthoPillarTransition(from, { ...to, contextError: "invalid_context" })).toBe(false);
  });
});

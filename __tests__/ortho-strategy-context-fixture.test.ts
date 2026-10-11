import { describe, expect, it } from "vitest";
import { strategyClinicalContext } from "./fixtures/strategy-clinical-context";
import { STRATEGY_IDS } from "./fixtures/ortho-strategy";

describe("exact synthetic strategy navigation graph", () => {
  const ids = STRATEGY_IDS.a;
  const query = () => new URLSearchParams({ patientId: "41", orthoCaseId: String(ids.orthoCaseId), pillar: "prescription" });
  it("returns only the exact owned case and recorded bridge", () => {
    expect(strategyClinicalContext(41, "a", query(), ids.clinicalCaseId)).toEqual({ ok: true,
      specialty: "orthodontics", sub: "ortho", context: { patientId: 41,
        orthoCaseId: ids.orthoCaseId, clinicalCaseId: ids.clinicalCaseId, pillar: "prescription" } });
    expect(strategyClinicalContext(41, "a", query(), null)).toEqual({ ok: true,
      specialty: "orthodontics", sub: "ortho", context: { patientId: 41, orthoCaseId: ids.orthoCaseId, pillar: "prescription" } });
  });
  it.each([
    ["patientId", "42"], ["orthoCaseId", String(STRATEGY_IDS.b.orthoCaseId)],
    ["clinicalCaseId", String(STRATEGY_IDS.b.clinicalCaseId)], ["planId", "12"],
    ["planItemId", String(ids.planItemId)], ["visitId", "99"], ["pillar", "unknown"],
  ])("refuses mismatched or unrecorded %s", (key, value) => {
    const search = query(); search.set(key, value);
    expect(strategyClinicalContext(41, "a", search, ids.clinicalCaseId)).toEqual({ ok: false, reason: "context_mismatch" });
  });
  it("refuses duplicate keys and a fabricated bridge", () => {
    const duplicate = query(); duplicate.append("patientId", "41");
    expect(strategyClinicalContext(41, "a", duplicate, ids.clinicalCaseId).ok).toBe(false);
    const old = query(); old.set("clinicalCaseId", String(ids.clinicalCaseId));
    expect(strategyClinicalContext(41, "a", old, null).ok).toBe(false);
    old.set("clinicalCaseId", "null");
    expect(strategyClinicalContext(41, "a", old, null).ok).toBe(false);
    expect(strategyClinicalContext(41, "a", query(), STRATEGY_IDS.b.clinicalCaseId).ok).toBe(false);
  });
});

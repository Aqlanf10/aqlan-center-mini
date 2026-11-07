import { describe, expect, it } from "vitest";
import { boltonArithmetic, permanentArchSpaceArithmetic } from "../lib/ortho-assessment-arithmetic-2_1_0";
import { deriveDraftAnalysisV2 } from "../lib/ortho-assessment-engine-v2";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";

// Independent tooth lists and integer hundredths are deliberate: expected
// values must not import the implementation's tooth masks or floating sums.
// See docs/ortho/local-diagnostic-audit-20261105.md for protocol references.
const upperAnterior = [13, 12, 11, 21, 22, 23];
const lowerAnterior = [43, 42, 41, 31, 32, 33];
const upperOverall = [16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26];
const lowerOverall = [46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36];
const rows = (teeth: number[], hundredths: number[]) => teeth.map((tooth, i) => ({ tooth, value: hundredths[i] / 100 }));
const total = (hundredths: number[]) => hundredths.reduce((sum, value) => sum + BigInt(value), 0n);

describe("independent orthodontic numerical ground truths", () => {
  it.each([
    ["anterior", upperAnterior, lowerAnterior, [800, 700, 1000, 1000, 700, 800], [700, 600, 700, 700, 600, 700], 772],
    ["overall", upperOverall, lowerOverall, [1000, 700, 700, 800, 700, 1100, 1100, 700, 800, 700, 700, 1000], [1100, 750, 700, 700, 650, 600, 600, 650, 700, 700, 750, 1100], 913],
  ] as const)("%s Bolton preserves independent ratio and signed reference-arch residuals", (mode, upperTeeth, lowerTeeth, u, l, referenceTenths) => {
    const U = total([...u]), L = total([...l]), R = BigInt(referenceTenths);
    const actual = boltonArithmetic(mode, rows([...upperTeeth], [...u]), rows([...lowerTeeth], [...l]), referenceTenths / 10);
    if (!actual.ok) throw Error(actual.code);
    expect(actual.value.upperSumMm).toBeCloseTo(Number(U) / 100, 11);
    expect(actual.value.lowerSumMm).toBeCloseTo(Number(L) / 100, 11);
    expect(actual.value.ratioPercent).toBeCloseTo(Number(100n * L) / Number(U), 11);
    expect(actual.value.upperReferenceLowerResidualMm).toBeCloseTo(Number(1000n * L - R * U) / 100000, 11);
    expect(actual.value.lowerReferenceUpperResidualMm).toBeCloseTo(Number(R * U - 1000n * L) / Number(100n * R), 11);
    expect(boltonArithmetic(mode, rows([...upperTeeth], [...u]).reverse(), rows([...lowerTeeth], [...l]).reverse(), referenceTenths / 10)).toEqual(actual);
  });
  it("keeps ratios invariant to units scaling while residuals scale, rather than confusing percent with mm", () => {
    const u = rows(upperAnterior, [800, 700, 1000, 1000, 700, 800]), l = rows(lowerAnterior, [700, 600, 700, 700, 600, 700]);
    const first = boltonArithmetic("anterior", u, l, 77.2), second = boltonArithmetic("anterior", u.map(r => ({ ...r, value: r.value * 2 })), l.map(r => ({ ...r, value: r.value * 2 })), 77.2);
    if (!first.ok || !second.ok) throw Error("invalid synthetic scaling fixture");
    expect(second.value.ratioPercent).toBe(first.value.ratioPercent);
    expect(second.value.upperReferenceLowerResidualMm).toBeCloseTo(first.value.upperReferenceLowerResidualMm * 2, 11);
    expect(second.value.lowerReferenceUpperResidualMm).toBeCloseTo(first.value.lowerReferenceUpperResidualMm * 2, 11);
  });
  it.each([72.5, 74, 76.25])("uses ten widths and available-minus-required at available %s mm", available => {
    const actual = permanentArchSpaceArithmetic("upper", rows([15, 14, 13, 12, 11, 21, 22, 23, 24, 25], [700, 700, 800, 700, 800, 800, 700, 800, 700, 700]), available);
    expect(actual).toEqual({ ok: true, value: { arch: "upper", requiredMm: 74, availableMm: available, discrepancyMm: available - 74, formula: "available_minus_required_v2" } });
  });
  it("does not count first molars in space or anterior Bolton, but requires them for overall Bolton", () => {
    const draft = assessmentCommandV2().content;
    const molar = draft.observations.observations.find(o => o.id === "width_16")!;
    molar.value = { state: "tooth_absent", reason: "Synthetic absent first molar" };
    const [space, , anterior, overall] = draft.analyses.map(selection => deriveDraftAnalysisV2(draft, draft.measurementSets[0], selection));
    expect(space).toMatchObject({ ok: true, value: { state: "ready", witness: { result: { method: "arch_space", requiredMm: 70 } } } });
    expect(anterior).toMatchObject({ ok: true, value: { state: "ready", witness: { result: { method: "bolton_anterior", upperMm: 42, lowerMm: 42 } } } });
    expect(overall).toMatchObject({ ok: true, value: { state: "inapplicable", reason: "tooth_absent", tooth: 16 } });
  });
  it.each(["primary", "mixed"])("does not calculate permanent-tooth analyses for %s dentition", text => {
    const draft = assessmentCommandV2().content;
    draft.observations.observations.find(o => o.id === "dentition")!.value = { state: "recorded", text };
    for (const selection of draft.analyses) expect(deriveDraftAnalysisV2(draft, draft.measurementSets[0], selection))
      .toMatchObject({ ok: true, value: { state: "unsupported_dentition" } });
  });
});

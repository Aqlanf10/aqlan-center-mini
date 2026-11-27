import { describe, expect, it } from "vitest";
import {
  computeAshleyHowe,
  computeBaldridgeCurveOfSpee,
  computeBoltonAnalysis,
  computeHuckabaCorrection,
  computeLittleIrregularityIndex,
  computeMoyersAnalysis,
  computeTanakaJohnston,
  MOYERS_SEX_STRATIFIED_TABLES,
  validateCephClinicalApproval,
} from "@/lib/ortho-scientific-analyses";
import { REQUIRED_LANDMARKS } from "@/lib/ceph";
import type { FdiToothRecord } from "@/lib/ortho-workspace-types";

function makeTeeth(widths: Record<number, number>): Record<string, FdiToothRecord> {
  const out: Record<string, FdiToothRecord> = {};
  for (const [fdi, widthMm] of Object.entries(widths)) {
    out[fdi] = {
      fdi: Number(fdi),
      dentition: "permanent",
      status: "present",
      widthMm,
      note: "",
    };
  }
  return out;
}

describe("Scientifically Verified Orthodontic Analyses (Proffit 7th Ed)", () => {
  it("contains all 208 exact sex-stratified Moyers (1988) cells and refuses out-of-range extrapolation", () => {
    let totalCells = 0;
    for (const sex of ["male", "female"] as const) {
      for (const arch of ["upper", "lower"] as const) {
        for (const pct of [50, 75, 85, 95] as const) {
          totalCells += MOYERS_SEX_STRATIFIED_TABLES[sex][arch][pct].length;
        }
      }
    }
    expect(totalCells).toBe(208);

    // Exact Male vs Female differentiation at 22.0 mm (75th percentile)
    const teeth22 = makeTeeth({ 42: 5.5, 41: 5.5, 31: 5.5, 32: 5.5 });
    const maleRes = computeMoyersAnalysis({
      teeth: teeth22,
      dentitionStage: "mixed",
      percentile: 75,
      sex: "male",
    });
    const femaleRes = computeMoyersAnalysis({
      teeth: teeth22,
      dentitionStage: "mixed",
      percentile: 75,
      sex: "female",
    });
    expect(maleRes.status).toBe("calculated");
    expect(femaleRes.status).toBe("calculated");
    if (maleRes.status === "calculated" && femaleRes.status === "calculated") {
      expect(maleRes.predictedMaxillaryQuadrantMm).toBe(21.5);
      expect(maleRes.predictedMandibularQuadrantMm).toBe(21.4);
      expect(femaleRes.predictedMaxillaryQuadrantMm).toBe(21.0);
      expect(femaleRes.predictedMandibularQuadrantMm).toBe(20.8);
    }

    // Strict out-of-range refusal below 19.5 mm and above 25.5 mm
    const tooSmall = makeTeeth({ 42: 4.5, 41: 4.5, 31: 4.5, 32: 4.5 }); // 18.0 mm
    const outLow = computeMoyersAnalysis({ teeth: tooSmall, dentitionStage: "mixed", percentile: 75 });
    expect(outLow.status).toBe("out_of_range");

    const tooLarge = makeTeeth({ 42: 6.8, 41: 6.8, 31: 6.8, 32: 6.8 }); // 27.2 mm
    const outHigh = computeMoyersAnalysis({ teeth: tooLarge, dentitionStage: "mixed", percentile: 75 });
    expect(outHigh.status).toBe("out_of_range");
  });

  it("refuses incomplete Bolton, Little, Curve of Spee, and Ceph < 24 confirmed landmarks", () => {
    const partialTeeth = makeTeeth({ 11: 8.5, 21: 8.5 });
    expect(computeBoltonAnalysis(partialTeeth, "anterior").status).toBe("incomplete");
    expect(computeTanakaJohnston({ teeth: partialTeeth, dentitionStage: "mixed" }).status).toBe("incomplete");

    expect(computeLittleIrregularityIndex([1.2, 0.8, null, 1.0, 0.5]).status).toBe("incomplete");
    const littleOk = computeLittleIrregularityIndex([1.5, 1.0, 2.0, 1.5, 1.0]);
    expect(littleOk).toMatchObject({ status: "calculated", indexMm: 7, severity: "severe" });

    const speeOk = computeBaldridgeCurveOfSpee({ leftDepthMm: 2.0, rightDepthMm: 3.0 });
    expect(speeOk).toMatchObject({ status: "calculated", meanDepthMm: 2.5, spaceRequiredMm: 3.0 });

    const huckaba = computeHuckabaCorrection({
      trueReferenceWidthMm: 7.5,
      radiographicReferenceWidthMm: 8.25,
      radiographicUneruptedWidthMm: 8.8,
    });
    expect(huckaba).toMatchObject({
      status: "calculated",
      magnificationFactor: 1.1,
      correctedTrueUneruptedWidthMm: 8,
    });

    const howeTeeth = makeTeeth({
      16: 10, 15: 7, 14: 7, 13: 8, 12: 7, 11: 8.5,
      21: 8.5, 22: 7, 23: 8, 24: 7, 25: 7, 26: 10,
    }); // TTM = 95 mm
    const howe = computeAshleyHowe({
      teeth: howeTeeth,
      premolarBasalArchWidthMm: 43,
      premolarDiameterPmdMm: 41,
    });
    expect(howe).toMatchObject({
      status: "calculated",
      expansionFeasible: true,
      category: "non_extraction_favorable",
    });

    // Ceph gate rejects AI-suggested unconfirmed landmarks or < 24 manual confirmed landmarks
    const suggestedOnly = REQUIRED_LANDMARKS.map((code, idx) => ({
      code,
      x: 100 + idx,
      y: 100 + idx,
      source: "suggested" as const,
      confirmedBy: "ai",
    }));
    const gateFail = validateCephClinicalApproval({ mmPerPixel: 0.1, landmarks: suggestedOnly });
    expect(gateFail.ok).toBe(false);
    expect(gateFail.confirmedCount).toBe(0);
  });
});

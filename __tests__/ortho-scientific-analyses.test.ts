import { describe, expect, it } from "vitest";
import { LANDMARKS, type LandmarkCode } from "@/lib/ceph";
import type { FdiToothRecord } from "@/lib/ortho-workspace-types";
import {
  MIN_CEPH_CONFIRMED_LANDMARKS,
  computeAshleyHowe,
  computeBoltonAnalysis,
  computeMoyersAnalysis,
  computeNanceAnalysis,
  computePermanentArchSpace,
  computePontIndex,
  computeTanakaJohnston,
  validateCephClinicalApproval,
} from "@/lib/ortho-scientific-analyses";

function makeTeeth(entries: Record<number, number>): Record<string, FdiToothRecord> {
  const out: Record<string, FdiToothRecord> = {};
  for (const [k, w] of Object.entries(entries)) {
    const fdi = Number(k);
    out[String(fdi)] = {
      fdi,
      dentition: fdi >= 51 ? "deciduous" : "permanent",
      status: "present",
      widthMm: w,
    };
  }
  return out;
}

describe("Scientifically Verified Orthodontic Analyses & 24-Landmark Ceph Gate (Package 4)", () => {
  it("enforces calibration and minimum 24 confirmed anatomical landmarks before ceph approval", () => {
    const sixteenCore = LANDMARKS.filter((l) => l.required).map((l, idx) => ({
      code: l.code as LandmarkCode,
      x: 100 + idx * 5,
      y: 100 + idx * 3,
      source: "manual" as const,
      confirmedBy: "dr_aqlan",
    }));

    // 16 core landmarks is insufficient under the 24-landmark clinical gate
    const failCount = validateCephClinicalApproval({
      mmPerPixel: 0.15,
      landmarks: sixteenCore,
    });
    expect(failCount.ok).toBe(false);
    expect(failCount.confirmedCount).toBe(16);
    expect(failCount.requiredMin).toBe(MIN_CEPH_CONFIRMED_LANDMARKS);

    // 24 landmarks but missing calibration -> rejected
    const twentyFour = LANDMARKS.slice(0, 24).map((l, idx) => ({
      code: l.code as LandmarkCode,
      x: 100 + idx * 5,
      y: 100 + idx * 3,
      source: "manual" as const,
      confirmedBy: "dr_aqlan",
    }));
    const failCal = validateCephClinicalApproval({
      mmPerPixel: null,
      landmarks: twentyFour,
    });
    expect(failCal.ok).toBe(false);
    expect(failCal.hasCalibration).toBe(false);

    // 24 landmarks with one unconfirmed AI suggestion -> only 23 confirmed -> rejected
    const withUnconfirmed = twentyFour.map((l, idx) =>
      idx === 23 ? { ...l, source: "suggested" as const, confirmedBy: null } : l,
    );
    const failUnconfirmed = validateCephClinicalApproval({
      mmPerPixel: 0.15,
      landmarks: withUnconfirmed,
    });
    expect(failUnconfirmed.ok).toBe(false);
    expect(failUnconfirmed.confirmedCount).toBe(23);
    expect(failUnconfirmed.unconfirmedCount).toBe(1);

    // Valid: calibration > 0 and 24 confirmed landmarks including all 16 core
    const pass = validateCephClinicalApproval({
      mmPerPixel: 0.15,
      landmarks: twentyFour,
    });
    expect(pass.ok).toBe(true);
    expect(pass.confirmedCount).toBe(24);
  });

  it("computes Bolton Anterior & Overall accurately and rejects missing teeth", () => {
    const balancedAnt = makeTeeth({
      13: 7.5, 12: 6.5, 11: 9.0, 21: 9.0, 22: 6.5, 23: 7.5, // sum = 46.0
      43: 6.75, 42: 5.75, 41: 5.255, 31: 5.255, 32: 5.75, 33: 6.75, // sum = 35.51
    });
    const r1 = computeBoltonAnalysis(balancedAnt, "anterior");
    expect(r1.status).toBe("calculated");
    if (r1.status === "calculated") {
      expect(r1.upperSumMm).toBe(46);
      expect(r1.ratioPercent).toBe(77.2);
      expect(r1.excessArch).toBe("balanced");
      expect(r1.clinicallySignificant).toBe(false);
    }

    // Mandibular anterior excess case: Lower 6 = 38.0 vs ideal 35.512 -> excess 2.49 mm
    const excessLower = makeTeeth({
      13: 7.5, 12: 6.5, 11: 9.0, 21: 9.0, 22: 6.5, 23: 7.5,
      43: 7.0, 42: 6.0, 41: 6.0, 31: 6.0, 32: 6.0, 33: 7.0,
    });
    const r2 = computeBoltonAnalysis(excessLower, "anterior");
    expect(r2.status).toBe("calculated");
    if (r2.status === "calculated") {
      expect(r2.excessArch).toBe("mandibular_excess");
      expect(r2.excessMm).toBeCloseTo(2.49, 2);
      expect(r2.clinicallySignificant).toBe(true);
    }

    // Missing tooth 23 -> incomplete
    delete excessLower["23"];
    const rMissing = computeBoltonAnalysis(excessLower, "anterior");
    expect(rMissing.status).toBe("incomplete");
    if (rMissing.status === "incomplete") {
      expect(rMissing.missingFdi).toContain(23);
    }
  });

  it("computes Moyers Mixed Dentition accurately with domain & dentition guards", () => {
    const incisors23 = makeTeeth({ 42: 6.0, 41: 5.5, 31: 5.5, 32: 6.0 }); // sum = 23.0
    const res = computeMoyersAnalysis({
      teeth: incisors23,
      dentitionStage: "mixed",
      percentile: 75,
      lowerAvailableSpaceMm: 65.0,
    });
    expect(res.status).toBe("calculated");
    if (res.status === "calculated") {
      expect(res.predictedMaxillaryQuadrantMm).toBe(22.6);
      expect(res.predictedMandibularQuadrantMm).toBe(22.2);
      expect(res.dentitionWarningAr).toBeNull();
      // 65.0 - (23.0 + 2*22.2) = 65.0 - 67.4 = -2.4 mm
      expect(res.lowerDiscrepancyMm).toBe(-2.4);
    }

    // Out of range guard (sum = 18.0 mm < 19.5 mm)
    const tooSmall = makeTeeth({ 42: 4.5, 41: 4.5, 31: 4.5, 32: 4.5 });
    const outRes = computeMoyersAnalysis({
      teeth: tooSmall,
      dentitionStage: "mixed",
      percentile: 75,
    });
    expect(outRes.status).toBe("out_of_range");
  });

  it("computes Tanaka & Johnston accurately", () => {
    const incisors23 = makeTeeth({ 42: 6.0, 41: 5.5, 31: 5.5, 32: 6.0 }); // sum = 23.0
    const res = computeTanakaJohnston({
      teeth: incisors23,
      dentitionStage: "mixed",
      lowerAvailableSpaceMm: 66.0,
    });
    expect(res.status).toBe("calculated");
    if (res.status === "calculated") {
      expect(res.predictedMaxillaryQuadrantMm).toBe(22.5);
      expect(res.predictedMandibularQuadrantMm).toBe(22.0);
      expect(res.lowerTotalRequiredMm).toBe(67.0);
      expect(res.lowerDiscrepancyMm).toBe(-1.0);
    }
  });

  it("computes Nance, Pont, Ashley Howe, and Permanent Arch Space accurately", () => {
    // Pont: SI = 32.0 -> Premolar ideal 40.0, Molar ideal 50.0
    const upperIncisors = makeTeeth({ 12: 7.0, 11: 9.0, 21: 9.0, 22: 7.0 });
    const pont = computePontIndex({
      teeth: upperIncisors,
      measuredPremolarWidthMm: 36.0,
      measuredMolarWidthMm: 47.0,
    });
    expect(pont.status).toBe("calculated");
    if (pont.status === "calculated") {
      expect(pont.idealPremolarWidthMm).toBe(40.0);
      expect(pont.idealMolarWidthMm).toBe(50.0);
      expect(pont.premolarDiffMm).toBe(-4.0);
      expect(pont.molarDiffMm).toBe(-3.0);
      expect(pont.scientificCaveatAr).toContain("Proffit");
    }

    // Ashley Howe: TTM (16..26) = 90.0 mm
    const upper12 = makeTeeth({
      16: 10, 15: 7, 14: 7, 13: 7.5, 12: 6.5, 11: 7.0,
      21: 7.0, 22: 6.5, 23: 7.5, 24: 7, 25: 7, 26: 10,
    }); // sum = 90.0
    const howeGood = computeAshleyHowe({ teeth: upper12, premolarBasalArchWidthMm: 41.0 });
    expect(howeGood.status).toBe("calculated");
    if (howeGood.status === "calculated") {
      expect(howeGood.ratioPercent).toBe(45.56);
      expect(howeGood.category).toBe("non_extraction_favorable");
    }
    const howeLow = computeAshleyHowe({ teeth: upper12, premolarBasalArchWidthMm: 32.0 });
    expect(howeLow.status).toBe("calculated");
    if (howeLow.status === "calculated") {
      expect(howeLow.category).toBe("basal_deficiency_extraction");
    }

    // Nance: lower 4 = 23.0, predicted quadrant = 21.5 -> required = 66.0, available = 64.0 -> -2.0
    const lower4 = makeTeeth({ 42: 6.0, 41: 5.5, 31: 5.5, 32: 6.0 });
    const nance = computeNanceAnalysis({
      teeth: lower4,
      dentitionStage: "mixed",
      upperAvailableSpaceMm: null,
      lowerAvailableSpaceMm: 64.0,
      nanceUpperPredictedMm: null,
      nanceLowerPredictedMm: 21.5,
    });
    expect(nance.status).toBe("calculated");
    if (nance.status === "calculated") {
      expect(nance.lowerDiscrepancyMm).toBe(-2.0);
      expect(nance.normLeewayLowerArchMm).toBe(3.4);
      expect(nance.normLeewayUpperArchMm).toBe(1.8);
    }

    // Permanent Arch Space Upper (15..25) = 70.0 mm, available = 66.5 mm -> -3.5 mm crowding
    const spaceU = computePermanentArchSpace({
      teeth: upper12,
      arch: "upper",
      availableSpaceMm: 66.5,
    });
    expect(spaceU.status).toBe("calculated");
    if (spaceU.status === "calculated") {
      expect(spaceU.requiredMm).toBe(70.0);
      expect(spaceU.discrepancyMm).toBe(-3.5);
    }
  });
});

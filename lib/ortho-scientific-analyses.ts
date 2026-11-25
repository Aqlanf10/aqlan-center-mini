/**
 * AQLAN Center Mini — Scientifically Verified Orthodontic Analyses Engine
 *
 * Grounded in:
 * - Proffit WR, Fields HW, Larson BE, Sarver DM. Contemporary Orthodontics, 7th Edition.
 * - Bolton WA (1958, 1962) Tooth Size Discrepancy Analysis.
 * - Moyers RE (1988) Mixed Dentition Probability Tables.
 * - Tanaka MM, Johnston LE (1974) Prediction of Unerupted Canines and Premolars.
 * - Nance HN (1947) Limitations of Orthodontic Treatment — Mixed Dentition & Leeway Space.
 * - Pont A (1909) Transverse Arch Width Index (adjunct only, with scientific caveat).
 * - Howes AE (1947) Apical Base / Basal Arch Width Analysis.
 *
 * Core safety guarantees:
 * 1. NEVER compute or fabricate a result when required teeth, landmarks, or calibration are missing.
 * 2. Return explicit `status: "incomplete" | "out_of_range" | "inapplicable"` with missing inputs list.
 * 3. Enforce clinical calibration + minimum 24 confirmed landmarks before cephalometric approval.
 */

import { REQUIRED_LANDMARKS, type LandmarkCode } from "./ceph";
import type { DentitionStage, FdiToothRecord } from "./ortho-workspace-types";

export const MIN_CEPH_CONFIRMED_LANDMARKS = 24 as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function getMeasuredWidth(teeth: Record<string, FdiToothRecord>, fdi: number): number | null {
  const rec = teeth[String(fdi)];
  if (!rec) return null;
  if (rec.status === "missing" || rec.status === "extracted" || rec.status === "unerupted") {
    return null;
  }
  if (typeof rec.widthMm !== "number" || !Number.isFinite(rec.widthMm) || rec.widthMm <= 0) {
    return null;
  }
  return rec.widthMm;
}

function sumTeeth(
  teeth: Record<string, FdiToothRecord>,
  fdiList: readonly number[],
): { ok: true; sumMm: number } | { ok: false; missingFdi: number[] } {
  const missingFdi: number[] = [];
  let sum = 0;
  for (const fdi of fdiList) {
    const w = getMeasuredWidth(teeth, fdi);
    if (w === null) missingFdi.push(fdi);
    else sum += w;
  }
  if (missingFdi.length > 0) return { ok: false, missingFdi };
  return { ok: true, sumMm: round2(sum) };
}

/* ─────────────────────────── 1. Ceph 24-Landmark & Calibration Gate ─────────────────────────── */

export interface CephApprovalCheckInput {
  mmPerPixel: number | null | undefined;
  landmarks: ReadonlyArray<{
    code: LandmarkCode;
    x: number;
    y: number;
    source: "manual" | "suggested";
    confirmedBy: string | null | undefined;
  }>;
  minimumLandmarks?: number;
}

export interface CephApprovalCheckResult {
  ok: boolean;
  confirmedCount: number;
  requiredMin: number;
  hasCalibration: boolean;
  missingRequiredCodes: LandmarkCode[];
  unconfirmedCount: number;
  errorsAr: string[];
}

export function validateCephClinicalApproval(input: CephApprovalCheckInput): CephApprovalCheckResult {
  const requiredMin = input.minimumLandmarks ?? MIN_CEPH_CONFIRMED_LANDMARKS;
  const hasCalibration =
    typeof input.mmPerPixel === "number" && Number.isFinite(input.mmPerPixel) && input.mmPerPixel > 0;

  const confirmedByCode = new Map<LandmarkCode, boolean>();
  let unconfirmedCount = 0;
  for (const lm of input.landmarks) {
    if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y)) continue;
    const isConfirmed = Boolean(lm.confirmedBy && lm.confirmedBy.trim().length > 0);
    if (isConfirmed) {
      confirmedByCode.set(lm.code, true);
    } else {
      unconfirmedCount++;
    }
  }

  const confirmedCount = confirmedByCode.size;
  const missingRequiredCodes = REQUIRED_LANDMARKS.filter((code) => !confirmedByCode.has(code));
  const errorsAr: string[] = [];

  if (!hasCalibration) {
    errorsAr.push("المعايرة المليمترية (mm/px) مطلوبة قبل اعتماد التحليل السيفالومتري.");
  }
  if (missingRequiredCodes.length > 0) {
    errorsAr.push(`معالم تشريحية أساسية ناقصة أو غير مؤكدة: ${missingRequiredCodes.join("، ")}.`);
  }
  if (confirmedCount < requiredMin) {
    errorsAr.push(
      `الحد الأدنى للاعتماد السريري هو ${requiredMin} معلمًا تشريحيًا مؤكدًا من الطبيب (المؤكد حاليًا: ${confirmedCount}).`,
    );
  }

  return {
    ok: errorsAr.length === 0,
    confirmedCount,
    requiredMin,
    hasCalibration,
    missingRequiredCodes,
    unconfirmedCount,
    errorsAr,
  };
}

/* ─────────────────────────── 2. Bolton Analysis (1958/1962) ─────────────────────────── */

export const BOLTON_UPPER_6 = [13, 12, 11, 21, 22, 23] as const;
export const BOLTON_LOWER_6 = [43, 42, 41, 31, 32, 33] as const;
export const BOLTON_UPPER_12 = [16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26] as const;
export const BOLTON_LOWER_12 = [46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36] as const;

export type BoltonResult =
  | {
      status: "incomplete";
      mode: "anterior" | "overall";
      missingFdi: number[];
      reference: string;
    }
  | {
      status: "calculated";
      mode: "anterior" | "overall";
      upperSumMm: number;
      lowerSumMm: number;
      ratioPercent: number;
      meanPercent: number;
      sdPercent: number;
      excessArch: "balanced" | "mandibular_excess" | "maxillary_excess";
      excessMm: number;
      clinicallySignificant: boolean;
      interpretationAr: string;
      reference: string;
    };

export function computeBoltonAnalysis(
  teeth: Record<string, FdiToothRecord>,
  mode: "anterior" | "overall",
): BoltonResult {
  const reference =
    mode === "anterior"
      ? "Bolton WA (1958, 1962) — Anterior 6 Ratio Mean 77.2% ± 1.65%; Contemporary Orthodontics 7th Ed"
      : "Bolton WA (1958, 1962) — Overall 12 Ratio Mean 91.3% ± 1.91%; Contemporary Orthodontics 7th Ed";

  const upperList = mode === "anterior" ? BOLTON_UPPER_6 : BOLTON_UPPER_12;
  const lowerList = mode === "anterior" ? BOLTON_LOWER_6 : BOLTON_LOWER_12;
  const u = sumTeeth(teeth, upperList);
  const l = sumTeeth(teeth, lowerList);

  if (!u.ok || !l.ok) {
    return {
      status: "incomplete",
      mode,
      missingFdi: [...(u.ok ? [] : u.missingFdi), ...(l.ok ? [] : l.missingFdi)],
      reference,
    };
  }

  const meanPercent = mode === "anterior" ? 77.2 : 91.3;
  const sdPercent = mode === "anterior" ? 1.65 : 1.91;
  const ratioPercent = round2((l.sumMm / u.sumMm) * 100);

  let excessArch: "balanced" | "mandibular_excess" | "maxillary_excess" = "balanced";
  let excessMm = 0;

  if (ratioPercent > meanPercent) {
    const idealLower = u.sumMm * (meanPercent / 100);
    excessMm = round2(l.sumMm - idealLower);
    excessArch = excessMm > 0.1 ? "mandibular_excess" : "balanced";
  } else if (ratioPercent < meanPercent) {
    const idealUpper = l.sumMm / (meanPercent / 100);
    excessMm = round2(u.sumMm - idealUpper);
    excessArch = excessMm > 0.1 ? "maxillary_excess" : "balanced";
  }

  const clinicallySignificant = excessMm >= 1.5 || Math.abs(ratioPercent - meanPercent) > 2 * sdPercent;
  const interpretationAr =
    excessArch === "balanced"
      ? `نسبة بولتون (${ratioPercent}%) متوازنة ضمن المعدل المرجعي (${meanPercent}% ± ${sdPercent}%).`
      : excessArch === "mandibular_excess"
        ? `زيادة في عرض الأسنان السفلية بمقدار ${excessMm} مم (النسبة ${ratioPercent}% مقابل ${meanPercent}%)${clinicallySignificant ? " — ذات دلالة سريرية" : " — طفيفة"}.`
        : `زيادة في عرض الأسنان العلوية بمقدار ${excessMm} مم (النسبة ${ratioPercent}% مقابل ${meanPercent}%)${clinicallySignificant ? " — ذات دلالة سريرية" : " — طفيفة"}.`;

  return {
    status: "calculated",
    mode,
    upperSumMm: u.sumMm,
    lowerSumMm: l.sumMm,
    ratioPercent,
    meanPercent,
    sdPercent,
    excessArch,
    excessMm,
    clinicallySignificant,
    interpretationAr,
    reference,
  };
}

/* ─────────────────────────── 3. Moyers Mixed Dentition Analysis (1988) ─────────────────────────── */

export const LOWER_INCISORS_FDI = [42, 41, 31, 32] as const;
export const UPPER_INCISORS_FDI = [12, 11, 21, 22] as const;

type MoyersPercentile = 50 | 75 | 85 | 95;

// Published Moyers (1988) probability tables (mm per quadrant for canine + 1st & 2nd premolars)
// Indexed by sum of 4 mandibular permanent incisors from 19.5 to 25.5 in 0.5 mm increments (13 steps).
const MOYERS_KEYS = [19.5, 20.0, 20.5, 21.0, 21.5, 22.0, 22.5, 23.0, 23.5, 24.0, 24.5, 25.0, 25.5] as const;

const MOYERS_MAXILLARY: Record<MoyersPercentile, readonly number[]> = {
  50: [20.3, 20.6, 20.9, 21.2, 21.5, 21.8, 22.0, 22.3, 22.6, 22.9, 23.2, 23.5, 23.8],
  75: [20.6, 20.9, 21.2, 21.5, 21.8, 22.0, 22.3, 22.6, 22.9, 23.1, 23.4, 23.7, 24.0],
  85: [20.9, 21.2, 21.5, 21.8, 22.1, 22.4, 22.6, 22.9, 23.2, 23.5, 23.8, 24.0, 24.3],
  95: [21.6, 21.8, 22.1, 22.4, 22.7, 22.9, 23.2, 23.5, 23.8, 24.0, 24.3, 24.6, 24.9],
};

const MOYERS_MANDIBULAR: Record<MoyersPercentile, readonly number[]> = {
  50: [19.7, 20.0, 20.3, 20.6, 20.9, 21.2, 21.5, 21.8, 22.1, 22.4, 22.7, 23.0, 23.3],
  75: [20.1, 20.4, 20.7, 21.0, 21.3, 21.6, 21.9, 22.2, 22.5, 22.8, 23.1, 23.4, 23.7],
  85: [20.4, 20.7, 21.0, 21.3, 21.6, 21.9, 22.2, 22.5, 22.8, 23.1, 23.4, 23.7, 24.0],
  95: [21.1, 21.4, 21.7, 22.0, 22.3, 22.6, 22.9, 23.2, 23.5, 23.8, 24.1, 24.4, 24.7],
};

function interpolateMoyers(table: readonly number[], sumLower4: number): number | null {
  if (sumLower4 < MOYERS_KEYS[0] || sumLower4 > MOYERS_KEYS[MOYERS_KEYS.length - 1]) return null;
  for (let i = 0; i < MOYERS_KEYS.length - 1; i++) {
    const x0 = MOYERS_KEYS[i];
    const x1 = MOYERS_KEYS[i + 1];
    if (sumLower4 >= x0 && sumLower4 <= x1) {
      const t = (sumLower4 - x0) / (x1 - x0);
      return round2(table[i] + t * (table[i + 1] - table[i]));
    }
  }
  return table[table.length - 1];
}

export type MoyersResult =
  | { status: "incomplete"; missingFdi: number[]; reference: string }
  | { status: "out_of_range"; lowerIncisorsSumMm: number; allowedRange: "19.5–25.5 mm"; reference: string }
  | {
      status: "calculated";
      percentile: MoyersPercentile;
      dentitionWarningAr: string | null;
      lowerIncisorsSumMm: number;
      predictedMaxillaryQuadrantMm: number;
      predictedMandibularQuadrantMm: number;
      lowerDiscrepancyMm: number | null;
      upperDiscrepancyMm: number | null;
      interpretationAr: string;
      reference: string;
    };

export function computeMoyersAnalysis(input: {
  teeth: Record<string, FdiToothRecord>;
  dentitionStage: DentitionStage;
  percentile: MoyersPercentile;
  upperAvailableSpaceMm?: number | null;
  lowerAvailableSpaceMm?: number | null;
}): MoyersResult {
  const reference =
    "Moyers RE (1988) Handbook of Orthodontics 4th Ed; Proffit Contemporary Orthodontics 7th Ed";
  const lower4 = sumTeeth(input.teeth, LOWER_INCISORS_FDI);
  if (!lower4.ok) {
    return { status: "incomplete", missingFdi: lower4.missingFdi, reference };
  }
  const maxPred = interpolateMoyers(MOYERS_MAXILLARY[input.percentile], lower4.sumMm);
  const manPred = interpolateMoyers(MOYERS_MANDIBULAR[input.percentile], lower4.sumMm);
  if (maxPred === null || manPred === null) {
    return {
      status: "out_of_range",
      lowerIncisorsSumMm: lower4.sumMm,
      allowedRange: "19.5–25.5 mm",
      reference,
    };
  }

  const dentitionWarningAr =
    input.dentitionStage !== "mixed"
      ? "تنبيه استطباب علمي: تحليل مويرز مخصص للإطباق المختلط (Mixed Dentition)."
      : null;

  const lowerTotalRequired = round2(lower4.sumMm + 2 * manPred);
  const lowerDiscrepancyMm =
    typeof input.lowerAvailableSpaceMm === "number" && Number.isFinite(input.lowerAvailableSpaceMm)
      ? round2(input.lowerAvailableSpaceMm - lowerTotalRequired)
      : null;

  const upper4 = sumTeeth(input.teeth, UPPER_INCISORS_FDI);
  const upperDiscrepancyMm =
    upper4.ok &&
    typeof input.upperAvailableSpaceMm === "number" &&
    Number.isFinite(input.upperAvailableSpaceMm)
      ? round2(input.upperAvailableSpaceMm - (upper4.sumMm + 2 * maxPred))
      : null;

  const interpretationAr = `عند نسبة احتمال ${input.percentile}% ومجموع القواطع السفلية ${lower4.sumMm} مم: المتوقع لكل ربع فك علوي ${maxPred} مم ولربع فك سفلي ${manPred} مم.`;

  return {
    status: "calculated",
    percentile: input.percentile,
    dentitionWarningAr,
    lowerIncisorsSumMm: lower4.sumMm,
    predictedMaxillaryQuadrantMm: maxPred,
    predictedMandibularQuadrantMm: manPred,
    lowerDiscrepancyMm,
    upperDiscrepancyMm,
    interpretationAr,
    reference,
  };
}

/* ─────────────────────────── 4. Tanaka & Johnston (1974) ─────────────────────────── */

export type TanakaJohnstonResult =
  | { status: "incomplete"; missingFdi: number[]; reference: string }
  | {
      status: "calculated";
      dentitionWarningAr: string | null;
      lowerIncisorsSumMm: number;
      predictedMaxillaryQuadrantMm: number;
      predictedMandibularQuadrantMm: number;
      lowerTotalRequiredMm: number;
      upperTotalRequiredMm: number | null;
      lowerDiscrepancyMm: number | null;
      upperDiscrepancyMm: number | null;
      interpretationAr: string;
      reference: string;
    };

export function computeTanakaJohnston(input: {
  teeth: Record<string, FdiToothRecord>;
  dentitionStage: DentitionStage;
  upperAvailableSpaceMm?: number | null;
  lowerAvailableSpaceMm?: number | null;
}): TanakaJohnstonResult {
  const reference =
    "Tanaka MM, Johnston LE (1974) JADA 88:798–801; Proffit Contemporary Orthodontics 7th Ed";
  const lower4 = sumTeeth(input.teeth, LOWER_INCISORS_FDI);
  if (!lower4.ok) {
    return { status: "incomplete", missingFdi: lower4.missingFdi, reference };
  }

  const predictedMandibularQuadrantMm = round2(lower4.sumMm / 2 + 10.5);
  const predictedMaxillaryQuadrantMm = round2(lower4.sumMm / 2 + 11.0);
  const lowerTotalRequiredMm = round2(lower4.sumMm + 2 * predictedMandibularQuadrantMm);

  const upper4 = sumTeeth(input.teeth, UPPER_INCISORS_FDI);
  const upperTotalRequiredMm = upper4.ok
    ? round2(upper4.sumMm + 2 * predictedMaxillaryQuadrantMm)
    : null;

  const lowerDiscrepancyMm =
    typeof input.lowerAvailableSpaceMm === "number" && Number.isFinite(input.lowerAvailableSpaceMm)
      ? round2(input.lowerAvailableSpaceMm - lowerTotalRequiredMm)
      : null;

  const upperDiscrepancyMm =
    upperTotalRequiredMm !== null &&
    typeof input.upperAvailableSpaceMm === "number" &&
    Number.isFinite(input.upperAvailableSpaceMm)
      ? round2(input.upperAvailableSpaceMm - upperTotalRequiredMm)
      : null;

  const dentitionWarningAr =
    input.dentitionStage !== "mixed"
      ? "تنبيه استطباب علمي: تحليل تاناكا وجونستون مخصص للإطباق المختلط (Mixed Dentition)."
      : null;

  return {
    status: "calculated",
    dentitionWarningAr,
    lowerIncisorsSumMm: lower4.sumMm,
    predictedMaxillaryQuadrantMm,
    predictedMandibularQuadrantMm,
    lowerTotalRequiredMm,
    upperTotalRequiredMm,
    lowerDiscrepancyMm,
    upperDiscrepancyMm,
    interpretationAr: `تاناكا وجونستون (احتمال 75%): المتوقع لكل ربع علوي ${predictedMaxillaryQuadrantMm} مم ولكل ربع سفلي ${predictedMandibularQuadrantMm} مم.`,
    reference,
  };
}

/* ─────────────────────────── 5. Nance Mixed Dentition & Leeway Space (1947) ─────────────────────────── */

export const NANCE_NORM_LEEWAY_UPPER_PER_SIDE_MM = 0.9 as const;
export const NANCE_NORM_LEEWAY_LOWER_PER_SIDE_MM = 1.7 as const;

export type NanceResult =
  | { status: "incomplete"; missingFieldsAr: string[]; reference: string }
  | {
      status: "calculated";
      dentitionWarningAr: string | null;
      upperDiscrepancyMm: number | null;
      lowerDiscrepancyMm: number | null;
      normLeewayUpperArchMm: number;
      normLeewayLowerArchMm: number;
      interpretationAr: string;
      reference: string;
    };

export function computeNanceAnalysis(input: {
  teeth: Record<string, FdiToothRecord>;
  dentitionStage: DentitionStage;
  upperAvailableSpaceMm: number | null;
  lowerAvailableSpaceMm: number | null;
  nanceUpperPredictedMm: number | null;
  nanceLowerPredictedMm: number | null;
}): NanceResult {
  const reference =
    "Nance HN (1947) Am J Orthod Oral Surg 33:177–223; Contemporary Orthodontics 7th Ed (Leeway: 0.9mm/side U, 1.7mm/side L)";
  const missingFieldsAr: string[] = [];

  const lower4 = sumTeeth(input.teeth, LOWER_INCISORS_FDI);
  const upper4 = sumTeeth(input.teeth, UPPER_INCISORS_FDI);

  const canLower =
    lower4.ok &&
    typeof input.lowerAvailableSpaceMm === "number" &&
    typeof input.nanceLowerPredictedMm === "number" &&
    input.nanceLowerPredictedMm > 0;

  const canUpper =
    upper4.ok &&
    typeof input.upperAvailableSpaceMm === "number" &&
    typeof input.nanceUpperPredictedMm === "number" &&
    input.nanceUpperPredictedMm > 0;

  if (!canLower && !canUpper) {
    if (!lower4.ok) missingFieldsAr.push("قياسات القواطع السفلية (42-32)");
    if (input.lowerAvailableSpaceMm == null && input.upperAvailableSpaceMm == null) {
      missingFieldsAr.push("المساحة المتاحة للقوس (mm)");
    }
    if (input.nanceLowerPredictedMm == null && input.nanceUpperPredictedMm == null) {
      missingFieldsAr.push("عرض الأنياب والضواحك المقاس شعاعيًا لكل ربع (mm)");
    }
    return { status: "incomplete", missingFieldsAr, reference };
  }

  const lowerDiscrepancyMm = canLower
    ? round2(input.lowerAvailableSpaceMm! - (lower4.sumMm + 2 * input.nanceLowerPredictedMm!))
    : null;
  const upperDiscrepancyMm = canUpper
    ? round2(input.upperAvailableSpaceMm! - (upper4.sumMm + 2 * input.nanceUpperPredictedMm!))
    : null;

  const dentitionWarningAr =
    input.dentitionStage !== "mixed"
      ? "تنبيه استطباب علمي: تحليل نانس ومسافة Leeway مخصصان للإطباق المختلط."
      : null;

  return {
    status: "calculated",
    dentitionWarningAr,
    upperDiscrepancyMm,
    lowerDiscrepancyMm,
    normLeewayUpperArchMm: round2(NANCE_NORM_LEEWAY_UPPER_PER_SIDE_MM * 2),
    normLeewayLowerArchMm: round2(NANCE_NORM_LEEWAY_LOWER_PER_SIDE_MM * 2),
    interpretationAr: `تحليل نانس (مع مراعاة Leeway المرجعية: 1.8 مم علوي / 3.4 مم سفلي): الفارق العلوي ${upperDiscrepancyMm ?? "—"} مم · الفارق السفلي ${lowerDiscrepancyMm ?? "—"} مم.`,
    reference,
  };
}

/* ─────────────────────────── 6. Pont's Index (1909 — Adjunct Guide) ─────────────────────────── */

export type PontResult =
  | { status: "incomplete"; missingFieldsAr: string[]; reference: string }
  | {
      status: "calculated";
      sumUpperIncisorsMm: number;
      idealPremolarWidthMm: number;
      idealMolarWidthMm: number;
      measuredPremolarWidthMm: number;
      measuredMolarWidthMm: number;
      premolarDiffMm: number;
      molarDiffMm: number;
      scientificCaveatAr: string;
      interpretationAr: string;
      reference: string;
    };

export function computePontIndex(input: {
  teeth: Record<string, FdiToothRecord>;
  measuredPremolarWidthMm: number | null;
  measuredMolarWidthMm: number | null;
}): PontResult {
  const reference =
    "Pont A (1909) — Premolar=SI×100/80, Molar=SI×100/64 (Adjunct screening only; Contemporary Orthodontics 7th Ed)";
  const upper4 = sumTeeth(input.teeth, UPPER_INCISORS_FDI);
  const missingFieldsAr: string[] = [];
  if (!upper4.ok) missingFieldsAr.push(`القواطع العلوية (${upper4.missingFdi.join("، ")})`);
  if (input.measuredPremolarWidthMm == null || input.measuredPremolarWidthMm <= 0) {
    missingFieldsAr.push("عرض الضواحك العلوية المقاس 14–24 (mm)");
  }
  if (input.measuredMolarWidthMm == null || input.measuredMolarWidthMm <= 0) {
    missingFieldsAr.push("عرض الأرحاء العلوية المقاس 16–26 (mm)");
  }
  if (missingFieldsAr.length > 0 || !upper4.ok) {
    return { status: "incomplete", missingFieldsAr, reference };
  }

  const idealPremolarWidthMm = round2((upper4.sumMm * 100) / 80);
  const idealMolarWidthMm = round2((upper4.sumMm * 100) / 64);
  const premolarDiffMm = round2(input.measuredPremolarWidthMm! - idealPremolarWidthMm);
  const molarDiffMm = round2(input.measuredMolarWidthMm! - idealMolarWidthMm);

  return {
    status: "calculated",
    sumUpperIncisorsMm: upper4.sumMm,
    idealPremolarWidthMm,
    idealMolarWidthMm,
    measuredPremolarWidthMm: input.measuredPremolarWidthMm!,
    measuredMolarWidthMm: input.measuredMolarWidthMm!,
    premolarDiffMm,
    molarDiffMm,
    scientificCaveatAr:
      "تنبيه علمي (Proffit): مؤشر بونت أداة استرشادية تاريخية مساعدة فقط ولا يُعتمد وحده لوصف التوسيع العرضي بسبب تباين النسب بين المجموعات السكانية.",
    interpretationAr: `مجموع القواطع العلوية ${upper4.sumMm} مم — المثالي للضواحك ${idealPremolarWidthMm} مم (الفارق ${premolarDiffMm} مم) وللأرحاء ${idealMolarWidthMm} مم (الفارق ${molarDiffMm} مم).`,
    reference,
  };
}

/* ─────────────────────────── 7. Ashley Howe's Analysis (1947) ─────────────────────────── */

export type AshleyHoweResult =
  | { status: "incomplete"; missingFieldsAr: string[]; reference: string }
  | {
      status: "calculated";
      ttmMm: number;
      pmbawMm: number;
      ratioPercent: number;
      category: "non_extraction_favorable" | "borderline" | "basal_deficiency_extraction";
      interpretationAr: string;
      reference: string;
    };

export function computeAshleyHowe(input: {
  teeth: Record<string, FdiToothRecord>;
  premolarBasalArchWidthMm: number | null;
}): AshleyHoweResult {
  const reference = "Howes AE (1947) Am J Orthod 33:499–533 — PMBAW / TTM (16–26) Ratio";
  const upper12 = sumTeeth(input.teeth, BOLTON_UPPER_12);
  const missingFieldsAr: string[] = [];
  if (!upper12.ok) missingFieldsAr.push(`الأسنان العلوية 16–26 (${upper12.missingFdi.join("، ")})`);
  if (input.premolarBasalArchWidthMm == null || input.premolarBasalArchWidthMm <= 0) {
    missingFieldsAr.push("عرض القاعدة العظمية للضواحك PMBAW (mm)");
  }
  if (missingFieldsAr.length > 0 || !upper12.ok) {
    return { status: "incomplete", missingFieldsAr, reference };
  }

  const ratioPercent = round2((input.premolarBasalArchWidthMm! / upper12.sumMm) * 100);
  const category =
    ratioPercent >= 44
      ? "non_extraction_favorable"
      : ratioPercent <= 37
        ? "basal_deficiency_extraction"
        : "borderline";

  const interpretationAr =
    category === "non_extraction_favorable"
      ? `نسبة القاعدة العظمية ${ratioPercent}% (≥ 44%): القاعدة القمية كافية وتدعم خيار عدم القلع.`
      : category === "basal_deficiency_extraction"
        ? `نسبة القاعدة العظمية ${ratioPercent}% (≤ 37%): نقص في القاعدة القمية يشير لاحتمال الحاجة للقلع أو التوسيع الهيكلي.`
        : `نسبة القاعدة العظمية ${ratioPercent}% (37%–44%): حالة حدّية (Borderline) تتطلب تقييمًا سيفالومتريًا ووجهيًا متكاملًا.`;

  return {
    status: "calculated",
    ttmMm: upper12.sumMm,
    pmbawMm: input.premolarBasalArchWidthMm!,
    ratioPercent,
    category,
    interpretationAr,
    reference,
  };
}

/* ─────────────────────────── 8. Permanent Arch Space Analysis ─────────────────────────── */

export const UPPER_10_FDI = [15, 14, 13, 12, 11, 21, 22, 23, 24, 25] as const;
export const LOWER_10_FDI = [45, 44, 43, 42, 41, 31, 32, 33, 34, 35] as const;

export type PermanentSpaceResult =
  | { status: "incomplete"; arch: "upper" | "lower"; missingFieldsAr: string[] }
  | {
      status: "calculated";
      arch: "upper" | "lower";
      requiredMm: number;
      availableMm: number;
      discrepancyMm: number;
      interpretationAr: string;
    };

export function computePermanentArchSpace(input: {
  teeth: Record<string, FdiToothRecord>;
  arch: "upper" | "lower";
  availableSpaceMm: number | null;
}): PermanentSpaceResult {
  const list = input.arch === "upper" ? UPPER_10_FDI : LOWER_10_FDI;
  const s = sumTeeth(input.teeth, list);
  const missingFieldsAr: string[] = [];
  if (!s.ok) missingFieldsAr.push(`الأسنان (${s.missingFdi.join("، ")})`);
  if (input.availableSpaceMm == null || !Number.isFinite(input.availableSpaceMm) || input.availableSpaceMm <= 0) {
    missingFieldsAr.push("المساحة المتاحة للقوس (mm)");
  }
  if (missingFieldsAr.length > 0 || !s.ok) {
    return { status: "incomplete", arch: input.arch, missingFieldsAr };
  }
  const discrepancyMm = round2(input.availableSpaceMm! - s.sumMm);
  const archLabel = input.arch === "upper" ? "العلوي" : "السفلي";
  const interpretationAr =
    discrepancyMm < 0
      ? `القوس ${archLabel}: ازدحام (نقص مسافة) بمقدار ${Math.abs(discrepancyMm)} مم (المتاح ${input.availableSpaceMm} مم مقابل المطلوب ${s.sumMm} مم).`
      : discrepancyMm > 0
        ? `القوس ${archLabel}: فائض مسافة (تباعد) بمقدار ${discrepancyMm} مم.`
        : `القوس ${archLabel}: توازن تام بين المساحة المتاحة والمطلوبة (${s.sumMm} مم).`;

  return {
    status: "calculated",
    arch: input.arch,
    requiredMm: s.sumMm,
    availableMm: input.availableSpaceMm!,
    discrepancyMm,
    interpretationAr,
  };
}

/**
 * AQLAN Center Mini — Scientifically Verified Orthodontic Analyses Engine
 *
 * Grounded in:
 * - Proffit WR, Fields HW, Larson BE, Sarver DM. Contemporary Orthodontics, 7th Edition (Table 11-4).
 * - Bolton WA (1958, 1962) Tooth Size Discrepancy Analysis.
 * - Moyers RE (1988) Handbook of Orthodontics 4th Ed — Sex-Stratified Mixed Dentition Probability Tables (208 cells).
 * - Tanaka MM, Johnston LE (1974) Prediction of Unerupted Canines and Premolars.
 * - Nance HN (1947) Limitations of Orthodontic Treatment — Mixed Dentition & Leeway Space.
 * - Huckaba GW (1964) Arch Size Analysis & Radiographic Magnification Correction (Y1 = X1 * Y2 / X2).
 * - Little RM (1975) The Irregularity Index: A Quantitative Score of Mandibular Anterior Alignment.
 * - Baldridge DW (1979) Leveling the Curve of Spee: Its Effect on Mandibular Arch Length.
 * - Pont A (1909) Transverse Arch Width Index (adjunct only, with scientific caveat).
 * - Howes AE (1947) Apical Base / Basal Arch Width Analysis (Inferences I & II).
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
    const isConfirmed =
      lm.source === "manual" && Boolean(lm.confirmedBy && lm.confirmedBy.trim().length > 0);
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
    errorsAr.push(`معالم تشريحية أساسية ناقصة أو غير مؤكدة يدويًا: ${missingRequiredCodes.join("، ")}.`);
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

/* ─────────────── 3. Moyers Sex-Stratified Mixed Dentition Analysis (1988 / Proffit Table 11-4) ─────────────── */

export const LOWER_INCISORS_FDI = [42, 41, 31, 32] as const;
export const UPPER_INCISORS_FDI = [12, 11, 21, 22] as const;

export type MoyersPercentile = 50 | 75 | 85 | 95;
export type MoyersSex = "male" | "female";

// Exact 13-step domain: sum of 4 mandibular permanent incisors from 19.5 to 25.5 mm (0.5 mm increments).
export const MOYERS_KEYS = [
  19.5, 20.0, 20.5, 21.0, 21.5, 22.0, 22.5, 23.0, 23.5, 24.0, 24.5, 25.0, 25.5,
] as const;

// Exact 208-cell Moyers (1988) / Proffit Contemporary Orthodontics 7th Ed Table 11-4 probability tables
// (mm per quadrant for permanent canine + 1st & 2nd premolars, stratified by sex and arch).
export const MOYERS_SEX_STRATIFIED_TABLES: Readonly<
  Record<MoyersSex, Readonly<Record<"upper" | "lower", Readonly<Record<MoyersPercentile, readonly number[]>>>>>
> = {
  male: {
    upper: {
      50: [19.7, 19.9, 20.2, 20.4, 20.7, 20.9, 21.2, 21.5, 21.7, 22.0, 22.2, 22.5, 22.7],
      75: [20.3, 20.5, 20.8, 21.0, 21.3, 21.5, 21.8, 22.0, 22.3, 22.5, 22.8, 23.0, 23.3],
      85: [20.6, 20.9, 21.1, 21.3, 21.6, 21.8, 22.1, 22.3, 22.6, 22.8, 23.1, 23.3, 23.6],
      95: [21.2, 21.4, 21.6, 21.9, 22.1, 22.3, 22.6, 22.8, 23.1, 23.4, 23.6, 23.9, 24.1],
    },
    lower: {
      50: [19.5, 19.7, 20.0, 20.2, 20.4, 20.6, 20.9, 21.1, 21.3, 21.5, 21.7, 22.0, 22.2],
      75: [20.4, 20.6, 20.8, 21.0, 21.2, 21.4, 21.6, 21.9, 22.1, 22.3, 22.5, 22.8, 23.0],
      85: [20.8, 21.0, 21.2, 21.4, 21.6, 21.9, 22.1, 22.3, 22.5, 22.7, 23.0, 23.2, 23.4],
      95: [21.6, 21.8, 22.0, 22.2, 22.4, 22.6, 22.8, 23.0, 23.2, 23.5, 23.7, 23.9, 24.2],
    },
  },
  female: {
    upper: {
      50: [19.6, 19.8, 19.9, 20.1, 20.2, 20.3, 20.5, 20.6, 20.8, 20.9, 21.0, 21.2, 21.3],
      75: [20.4, 20.5, 20.6, 20.8, 20.9, 21.0, 21.2, 21.3, 21.5, 21.6, 21.8, 21.9, 22.0],
      85: [20.8, 20.9, 21.0, 21.1, 21.3, 21.4, 21.5, 21.7, 21.8, 22.0, 22.1, 22.3, 22.4],
      95: [21.4, 21.6, 21.7, 21.8, 21.9, 22.0, 22.2, 22.3, 22.5, 22.6, 22.8, 22.9, 23.1],
    },
    lower: {
      50: [18.7, 19.0, 19.2, 19.5, 19.8, 20.0, 20.3, 20.5, 20.8, 21.1, 21.3, 21.6, 21.8],
      75: [19.6, 19.8, 20.1, 20.3, 20.6, 20.8, 21.1, 21.3, 21.6, 21.9, 22.1, 22.4, 22.7],
      85: [20.0, 20.3, 20.5, 20.7, 21.0, 21.2, 21.5, 21.8, 22.0, 22.3, 22.6, 22.8, 23.1],
      95: [20.8, 21.0, 21.2, 21.5, 21.7, 22.0, 22.2, 22.5, 22.7, 23.0, 23.3, 23.6, 23.9],
    },
  },
} as const;

function interpolateMoyersStrict(table: readonly number[], sumLower4: number): number | null {
  // Never extrapolate outside the published [19.5, 25.5] mm probability domain.
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
      sex: MoyersSex;
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
  sex?: MoyersSex | null;
  upperAvailableSpaceMm?: number | null;
  lowerAvailableSpaceMm?: number | null;
}): MoyersResult {
  const reference =
    "Moyers RE (1988) Handbook of Orthodontics 4th Ed; Proffit Contemporary Orthodontics 7th Ed (Table 11-4, Sex-Stratified)";
  const lower4 = sumTeeth(input.teeth, LOWER_INCISORS_FDI);
  if (!lower4.ok) {
    return { status: "incomplete", missingFdi: lower4.missingFdi, reference };
  }

  const sex: MoyersSex = input.sex === "female" ? "female" : "male";
  const sexTables = MOYERS_SEX_STRATIFIED_TABLES[sex];
  const maxPred = interpolateMoyersStrict(sexTables.upper[input.percentile], lower4.sumMm);
  const manPred = interpolateMoyersStrict(sexTables.lower[input.percentile], lower4.sumMm);
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

  const sexLabelAr = sex === "female" ? "إناث" : "ذكور";
  const interpretationAr = `جدول مويرز (${sexLabelAr} · احتمال ${input.percentile}%) عند مجموع القواطع السفلية ${lower4.sumMm} مم: المتوقع لكل ربع علوي ${maxPred} مم ولربع سفلي ${manPred} مم.`;

  return {
    status: "calculated",
    sex,
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

/* ─────────────────────────── 6. Huckaba Radiographic Distortion Correction (1964) ─────────────────────────── */

export type HuckabaResult =
  | { status: "incomplete"; missingFieldsAr: string[]; reference: string }
  | {
      status: "calculated";
      trueReferenceWidthMm: number;
      radiographicReferenceWidthMm: number;
      radiographicUneruptedWidthMm: number;
      magnificationFactor: number;
      correctedTrueUneruptedWidthMm: number;
      interpretationAr: string;
      reference: string;
    };

export function computeHuckabaCorrection(input: {
  trueReferenceWidthMm: number | null;
  radiographicReferenceWidthMm: number | null;
  radiographicUneruptedWidthMm: number | null;
}): HuckabaResult {
  const reference = "Huckaba GW (1964) Dent Clin North Am 8:431–440 — Y1 = (X1 × Y2) / X2";
  const missingFieldsAr: string[] = [];
  if (input.trueReferenceWidthMm == null || !Number.isFinite(input.trueReferenceWidthMm) || input.trueReferenceWidthMm <= 0) {
    missingFieldsAr.push("العرض الحقيقي للسن المرجعي على النموذج X1 (mm)");
  }
  if (input.radiographicReferenceWidthMm == null || !Number.isFinite(input.radiographicReferenceWidthMm) || input.radiographicReferenceWidthMm <= 0) {
    missingFieldsAr.push("العرض الشعاعي للسن المرجعي X2 (mm)");
  }
  if (input.radiographicUneruptedWidthMm == null || !Number.isFinite(input.radiographicUneruptedWidthMm) || input.radiographicUneruptedWidthMm <= 0) {
    missingFieldsAr.push("العرض الشعاعي للسن غير البازغ Y2 (mm)");
  }
  if (missingFieldsAr.length > 0) {
    return { status: "incomplete", missingFieldsAr, reference };
  }
  const magnificationFactor = round2(input.radiographicReferenceWidthMm! / input.trueReferenceWidthMm!);
  const correctedTrueUneruptedWidthMm = round2(
    (input.trueReferenceWidthMm! * input.radiographicUneruptedWidthMm!) / input.radiographicReferenceWidthMm!,
  );
  return {
    status: "calculated",
    trueReferenceWidthMm: input.trueReferenceWidthMm!,
    radiographicReferenceWidthMm: input.radiographicReferenceWidthMm!,
    radiographicUneruptedWidthMm: input.radiographicUneruptedWidthMm!,
    magnificationFactor,
    correctedTrueUneruptedWidthMm,
    interpretationAr: `معامل التكبير الشعاعي ${magnificationFactor}× — العرض الحقيقي المصحّح للسن غير البازغ: ${correctedTrueUneruptedWidthMm} مم.`,
    reference,
  };
}

/* ─────────────────────────── 7. Pont's Index (1909 — Adjunct Guide) ─────────────────────────── */

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

/* ─────────────────────────── 8. Ashley Howe's Analysis (1947 — Inferences I & II) ─────────────────────────── */

export type AshleyHoweResult =
  | { status: "incomplete"; missingFieldsAr: string[]; reference: string }
  | {
      status: "calculated";
      ttmMm: number;
      pmbawMm: number;
      pmdMm: number | null;
      expansionFeasible: boolean | null;
      inferenceIAr: string | null;
      ratioPercent: number;
      category: "non_extraction_favorable" | "borderline" | "basal_deficiency_extraction";
      interpretationAr: string;
      reference: string;
    };

export function computeAshleyHowe(input: {
  teeth: Record<string, FdiToothRecord>;
  premolarBasalArchWidthMm: number | null;
  premolarDiameterPmdMm?: number | null;
}): AshleyHoweResult {
  const reference = "Howes AE (1947) Am J Orthod 33:499–533 — Inference I (PMBAW vs PMD) & Inference II (PMBAW / TTM Ratio)";
  const upper12 = sumTeeth(input.teeth, BOLTON_UPPER_12);
  const missingFieldsAr: string[] = [];
  if (!upper12.ok) missingFieldsAr.push(`الأسنان العلوية 16–26 (${upper12.missingFdi.join("، ")})`);
  if (input.premolarBasalArchWidthMm == null || input.premolarBasalArchWidthMm <= 0) {
    missingFieldsAr.push("عرض القاعدة العظمية للضواحك PMBAW (mm)");
  }
  if (missingFieldsAr.length > 0 || !upper12.ok) {
    return { status: "incomplete", missingFieldsAr, reference };
  }

  const pmbawMm = input.premolarBasalArchWidthMm!;
  const pmdMm =
    typeof input.premolarDiameterPmdMm === "number" && Number.isFinite(input.premolarDiameterPmdMm) && input.premolarDiameterPmdMm > 0
      ? round2(input.premolarDiameterPmdMm)
      : null;
  const expansionFeasible = pmdMm !== null ? pmbawMm > pmdMm : null;
  const inferenceIAr =
    pmdMm !== null
      ? expansionFeasible
        ? `الاستنتاج الأول (PMBAW ${pmbawMm} > PMD ${pmdMm} مم): القاعدة العظمية أعرض من القوس السني؛ توسيع القوس ممكن.`
        : `الاستنتاج الأول (PMBAW ${pmbawMm} ≤ PMD ${pmdMm} مم): القاعدة العظمية أضيق أو مساوية لعرض القوس؛ يُحذّر من التوسيع السني.`
      : null;

  const ratioPercent = round2((pmbawMm / upper12.sumMm) * 100);
  const category =
    ratioPercent >= 44
      ? "non_extraction_favorable"
      : ratioPercent <= 37
        ? "basal_deficiency_extraction"
        : "borderline";

  const interpretationAr =
    category === "non_extraction_favorable"
      ? `نسبة القاعدة العظمية ${ratioPercent}% (≥ 44%): القاعدة القمية كافية وتدعم خيار عدم القلع.${inferenceIAr ? ` ${inferenceIAr}` : ""}`
      : category === "basal_deficiency_extraction"
        ? `نسبة القاعدة العظمية ${ratioPercent}% (≤ 37%): نقص في القاعدة القمية يشير لاحتمال الحاجة للقلع أو التوسيع الهيكلي.${inferenceIAr ? ` ${inferenceIAr}` : ""}`
        : `نسبة القاعدة العظمية ${ratioPercent}% (37%–44%): حالة حدّية (Borderline) تتطلب تقييمًا سيفالومتريًا ووجهيًا متكاملًا.${inferenceIAr ? ` ${inferenceIAr}` : ""}`;

  return {
    status: "calculated",
    ttmMm: upper12.sumMm,
    pmbawMm,
    pmdMm,
    expansionFeasible,
    inferenceIAr,
    ratioPercent,
    category,
    interpretationAr,
    reference,
  };
}

/* ─────────────────────────── 9. Little's Irregularity Index (1975) ─────────────────────────── */

export type LittleIrregularityResult =
  | { status: "incomplete"; missingContactsCount: number; reference: string }
  | {
      status: "calculated";
      contactsMm: readonly [number, number, number, number, number];
      indexMm: number;
      severity: "ideal" | "minimal" | "moderate" | "severe" | "very_severe";
      interpretationAr: string;
      reference: string;
    };

export function computeLittleIrregularityIndex(
  contacts: ReadonlyArray<number | null | undefined>,
): LittleIrregularityResult {
  const reference =
    "Little RM (1975) Am J Orthod 68(5):554–563 — Sum of 5 Mandibular Anterior Contact Displacements (43-42, 42-41, 41-31, 31-32, 32-33)";
  if (!Array.isArray(contacts) || contacts.length !== 5) {
    return {
      status: "incomplete",
      missingContactsCount: Array.isArray(contacts) ? Math.max(1, 5 - contacts.length) : 5,
      reference,
    };
  }
  const validated: number[] = [];
  let missing = 0;
  for (const c of contacts) {
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0) {
      missing++;
    } else {
      validated.push(round2(c));
    }
  }
  if (missing > 0) {
    return { status: "incomplete", missingContactsCount: missing, reference };
  }
  const tuple = validated as unknown as readonly [number, number, number, number, number];
  const indexMm = round2(tuple.reduce((acc, v) => acc + v, 0));
  const severity =
    indexMm < 1
      ? "ideal"
      : indexMm <= 3
        ? "minimal"
        : indexMm <= 6
          ? "moderate"
          : indexMm <= 9
            ? "severe"
            : "very_severe";
  const labelMap: Record<typeof severity, string> = {
    ideal: "اصطفاف مثالي (0–0.9 مم)",
    minimal: "عدم انتظام بسيط (1–3 مم)",
    moderate: "عدم انتظام متوسط (3.1–6 مم)",
    severe: "عدم انتظام شديد (6.1–9 مم)",
    very_severe: "عدم انتظام شديد جدًا (> 9 مم)",
  };
  return {
    status: "calculated",
    contactsMm: tuple,
    indexMm,
    severity,
    interpretationAr: `مؤشر ليتل لعدم الانتظام الأمامي السفلي: ${indexMm} مم — ${labelMap[severity]}.`,
    reference,
  };
}

/* ─────────────────────────── 10. Baldridge Curve of Spee Space Allowance (1979) ─────────────────────────── */

export type CurveOfSpeeAllowanceResult =
  | { status: "incomplete"; missingFieldsAr: string[]; reference: string }
  | {
      status: "calculated";
      leftDepthMm: number;
      rightDepthMm: number;
      meanDepthMm: number;
      spaceRequiredMm: number;
      interpretationAr: string;
      reference: string;
    };

export function computeBaldridgeCurveOfSpee(input: {
  leftDepthMm: number | null | undefined;
  rightDepthMm: number | null | undefined;
}): CurveOfSpeeAllowanceResult {
  const reference =
    "Baldridge DW (1979) J Clin Orthod; Proffit Contemporary Orthodontics 7th Ed — Space Required = (Left + Right)/2 + 0.5 mm";
  const missingFieldsAr: string[] = [];
  if (typeof input.leftDepthMm !== "number" || !Number.isFinite(input.leftDepthMm) || input.leftDepthMm < 0) {
    missingFieldsAr.push("عمق قوس سبي الأيسر (mm)");
  }
  if (typeof input.rightDepthMm !== "number" || !Number.isFinite(input.rightDepthMm) || input.rightDepthMm < 0) {
    missingFieldsAr.push("عمق قوس سبي الأيمن (mm)");
  }
  if (missingFieldsAr.length > 0) {
    return { status: "incomplete", missingFieldsAr, reference };
  }
  const left = round2(input.leftDepthMm!);
  const right = round2(input.rightDepthMm!);
  const meanDepthMm = round2((left + right) / 2);
  const spaceRequiredMm = meanDepthMm <= 0 ? 0 : round2((left + right) / 2 + 0.5);
  return {
    status: "calculated",
    leftDepthMm: left,
    rightDepthMm: right,
    meanDepthMm,
    spaceRequiredMm,
    interpretationAr:
      spaceRequiredMm === 0
        ? "قوس سبي مسطّح (0 مم) — لا يتطلب مسافة قوسية إضافية للتسطيح."
        : `متوسط عمق قوس سبي ${meanDepthMm} مم — المساحة المطلوبة لتسطيح القوس وفق معادلة Baldridge: ${spaceRequiredMm} مم.`,
    reference,
  };
}

/* ─────────────────────────── 11. Permanent Arch Space Analysis ─────────────────────────── */

export const UPPER_10_FDI = [15, 14, 13, 12, 11, 21, 22, 23, 24, 25] as const;
export const LOWER_10_FDI = [45, 44, 43, 42, 41, 31, 32, 33, 34, 35] as const;

export type PermanentSpaceResult =
  | { status: "incomplete"; arch: "upper" | "lower"; missingFieldsAr: string[] }
  | {
      status: "calculated";
      arch: "upper" | "lower";
      requiredMm: number;
      availableMm: number;
      curveOfSpeeAllowanceMm: number;
      discrepancyMm: number;
      interpretationAr: string;
    };

export function computePermanentArchSpace(input: {
  teeth: Record<string, FdiToothRecord>;
  arch: "upper" | "lower";
  availableSpaceMm: number | null;
  curveOfSpeeAllowanceMm?: number | null;
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
  const spee =
    input.arch === "lower" &&
    typeof input.curveOfSpeeAllowanceMm === "number" &&
    Number.isFinite(input.curveOfSpeeAllowanceMm) &&
    input.curveOfSpeeAllowanceMm > 0
      ? round2(input.curveOfSpeeAllowanceMm)
      : 0;
  const totalRequiredMm = round2(s.sumMm + spee);
  const discrepancyMm = round2(input.availableSpaceMm! - totalRequiredMm);
  const archLabel = input.arch === "upper" ? "العلوي" : "السفلي";
  const interpretationAr =
    discrepancyMm < 0
      ? `القوس ${archLabel}: ازدحام (نقص مسافة) بمقدار ${Math.abs(discrepancyMm)} مم (المتاح ${input.availableSpaceMm} مم مقابل المطلوب ${totalRequiredMm} مم).`
      : discrepancyMm > 0
        ? `القوس ${archLabel}: فائض مسافة (تباعد) بمقدار ${discrepancyMm} مم.`
        : `القوس ${archLabel}: توازن تام بين المساحة المتاحة والمطلوبة (${totalRequiredMm} مم).`;

  return {
    status: "calculated",
    arch: input.arch,
    requiredMm: totalRequiredMm,
    availableMm: input.availableSpaceMm!,
    curveOfSpeeAllowanceMm: spee,
    discrepancyMm,
    interpretationAr,
  };
}

/* ─────────────────────────── 10. Cephalometric Clinical Approval Gate (Charter §12, TD-11) ─────────────────────────── */

export const MIN_CEPH_APPROVAL_LANDMARKS = 24 as const;

export interface CephApprovalGateInput {
  calibrationValid: boolean;
  pixelsPerMm?: number | null;
  landmarks: Record<string, { x: number; y: number; source?: string } | undefined> | null | undefined;
  actorRole?: string | null;
}

export type CephApprovalGateResult =
  | { ok: true; confirmedLandmarkCount: number }
  | {
      ok: false;
      reason: "uncalibrated" | "insufficient_landmarks" | "unconfirmed_suggested" | "unauthorized_role";
      confirmedLandmarkCount: number;
      messageAr: string;
      messageEn: string;
    };

export function validateOrthoCephApprovalGate(input: CephApprovalGateInput): CephApprovalGateResult {
  const entries = Object.entries(input.landmarks ?? {}).filter(
    ([, pt]) => pt != null && typeof pt.x === "number" && Number.isFinite(pt.x) && typeof pt.y === "number" && Number.isFinite(pt.y),
  );
  const suggestedEntries = entries.filter(([, pt]) => pt?.source === "suggested");
  const confirmedCount = entries.length - suggestedEntries.length;

  if (!input.calibrationValid || (input.pixelsPerMm !== undefined && (input.pixelsPerMm === null || input.pixelsPerMm <= 0))) {
    return {
      ok: false,
      reason: "uncalibrated",
      confirmedLandmarkCount: confirmedCount,
      messageAr: "حُفظت الدراسة كمسودة غير معتمدة: يُشترط إجراء معايرة المسطرة (mm) أولًا قبل الاعتماد السريري.",
      messageEn: "Saved as unapproved draft: ruler calibration (mm) is required before clinical approval.",
    };
  }

  if (suggestedEntries.length > 0) {
    return {
      ok: false,
      reason: "unconfirmed_suggested",
      confirmedLandmarkCount: confirmedCount,
      messageAr: "حُفظت الدراسة كمسودة: توجد معالم مقترحة آليًا يجب تأكيدها يدويًا من الطبيب قبل الاعتماد.",
      messageEn: "Saved as draft: AI-suggested landmarks must be manually confirmed by the clinician before approval.",
    };
  }

  if (confirmedCount < MIN_CEPH_APPROVAL_LANDMARKS) {
    return {
      ok: false,
      reason: "insufficient_landmarks",
      confirmedLandmarkCount: confirmedCount,
      messageAr: `حُفظت الدراسة كمسودة غير معتمدة: يلزم تحديد ${MIN_CEPH_APPROVAL_LANDMARKS} معلمًا تشريحيًا على الأقل للاعتماد السريري الشامل (المحدد حاليًا: ${confirmedCount}).`,
      messageEn: `Saved as unapproved draft: at least ${MIN_CEPH_APPROVAL_LANDMARKS} confirmed anatomical landmarks are required for clinical approval (placed: ${confirmedCount}).`,
    };
  }

  if (input.actorRole && input.actorRole !== "doctor" && input.actorRole !== "admin") {
    return {
      ok: false,
      reason: "unauthorized_role",
      confirmedLandmarkCount: confirmedCount,
      messageAr: "الاعتماد السريري للسيفالومتري محصور بالطبيب المختص.",
      messageEn: "Clinical cephalometric approval is restricted to clinicians.",
    };
  }

  return { ok: true, confirmedLandmarkCount: confirmedCount };
}

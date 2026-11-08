import { cephHandedness, isFiniteCephPoint, type LandmarkCode, type LandmarkMap } from "./ceph";

/**
 * Descriptive SN alignment in calibrated millimetres, returned in reference
 * image pixels. The caller resolves reference/comparison orientation: these
 * inputs are not inherently earlier/later acquisitions or treatment phases.
 *
 * Each image uses its own mm-per-pixel calibration. SN lengths are not forced
 * equal, so measured differences remain visible. Such a difference alone does
 * not establish growth, treatment effect or true movement; interpretation also
 * depends on acquisition metadata, calibration and landmark accuracy.
 */

export interface SuperimposeInput {
  /** المعالم ببكسل الصورة الطبيعي. */
  points: LandmarkMap;
  /** ملم/بكسل لهذه الصورة — من معايرتها. */
  mmPerPixel: number | null;
}

export interface Superimposition {
  /** Comparison landmarks transformed into reference image pixels. */
  points: LandmarkMap;
  /** Measured SN lengths in mm for reference/comparison, not inferred growth. */
  cranialBaseBefore: number;
  cranialBaseAfter: number;
  /** Rotation of the comparison onto the reference SN line, in degrees. */
  rotationDegrees: number;
}

export type SuperimposeResult =
  | { ok: true; value: Superimposition }
  | { ok: false; message: string };

/** إلى فضاء المليمتر: البكسل مضروبًا في المقياس، والمحور الرأسي مقلوب. */
const toMm = (point: { x: number; y: number }, mmPerPixel: number) =>
  ({ x: point.x * mmPerPixel, y: -point.y * mmPerPixel });

/** ومنه إلى بكسل صورة الأساس — لتُرسم عليها. */
const toBasePx = (point: { x: number; y: number }, mmPerPixel: number): { x: number; y: number } =>
  ({ x: point.x / mmPerPixel, y: -point.y / mmPerPixel });

/** Align comparison (target) onto reference (base); neither role implies time. */
export function superimposeOnSN(base: SuperimposeInput, target: SuperimposeInput): SuperimposeResult {
  const baseS = base.points.S;
  const baseN = base.points.N;
  const targetS = target.points.S;
  const targetN = target.points.N;
  if (!baseS || !baseN || !targetS || !targetN) {
    return {
      ok: false,
      message: "التراكب يحتاج المعلمين S وN في التحليلين — ضعهما ثم أعد المحاولة.",
    };
  }

  if (base.mmPerPixel == null || target.mmPerPixel == null
      || !Number.isFinite(base.mmPerPixel) || base.mmPerPixel <= 0
      || !Number.isFinite(target.mmPerPixel) || target.mmPerPixel <= 0) {
    return {
      ok: false,
      message: "التراكب يحتاج معايرة الصورتين — بلا مقياسٍ معلوم لا يُعرف كم يساوي الفرق.",
    };
  }

  // Alignment needs actual finite coordinates, not atan2(0, 0)'s synthetic zero.
  if ([...Object.values(base.points), ...Object.values(target.points)]
      .some(point => point != null && !isFiniteCephPoint(point))) {
    return { ok: false, message: "التراكب غير متاح: توجد إحداثيات معالم غير صالحة." };
  }
  const baseHandedness = cephHandedness(base.points);
  const targetHandedness = cephHandedness(target.points);
  if (baseHandedness == null || targetHandedness == null) {
    return { ok: false, message: "التراكب يحتاج إطارًا تشريحيًا صالحًا من S وN وMe، دون نقاط متطابقة أو على خط واحد." };
  }
  if (baseHandedness !== targetHandedness) {
    return { ok: false, message: "اتجاه الصورتين معكوس: وحِّد اتجاه الصورة ومعالمها قبل التراكب؛ لا يُصحَّح الانعكاس بدوران فقط." };
  }

  const bs = toMm(baseS, base.mmPerPixel);
  const bn = toMm(baseN, base.mmPerPixel);
  const ts = toMm(targetS, target.mmPerPixel);
  const tn = toMm(targetN, target.mmPerPixel);

  const spanOf = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    Math.hypot(to.x - from.x, to.y - from.y);
  const baseSpan = spanOf(bs, bn);
  const targetSpan = spanOf(ts, tn);
  if (![bs, bn, ts, tn].every(isFiniteCephPoint)
      || !Number.isFinite(baseSpan) || baseSpan <= 0
      || !Number.isFinite(targetSpan) || targetSpan <= 0) {
    return { ok: false, message: "التراكب غير متاح: طول S-N أو مقياسه غير صالح." };
  }

  const baseAngle = Math.atan2(bn.y - bs.y, bn.x - bs.x);
  const targetAngle = Math.atan2(tn.y - ts.y, tn.x - ts.x);
  const rotation = baseAngle - targetAngle;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const moved: LandmarkMap = {};
  for (const [code, point] of Object.entries(target.points)) {
    if (!point) continue;
    const p = toMm(point, target.mmPerPixel);
    // Translate to comparison S, rotate, then place at reference S, all in mm.
    const dx = p.x - ts.x;
    const dy = p.y - ts.y;
    const transformed = toBasePx(
      { x: bs.x + dx * cos - dy * sin, y: bs.y + dx * sin + dy * cos },
      base.mmPerPixel,
    );
    if (!isFiniteCephPoint(p) || !isFiniteCephPoint(transformed)) {
      return { ok: false, message: "التراكب غير متاح: التحويل بالمقياس الحالي ينتج إحداثيات غير صالحة." };
    }
    moved[code as LandmarkCode] = transformed;
  }

  return {
    ok: true,
    value: {
      points: moved,
      // Descriptive measured lengths in mm; do not infer growth from their difference.
      cranialBaseBefore: baseSpan,
      cranialBaseAfter: targetSpan,
      rotationDegrees: (rotation * 180) / Math.PI,
    },
  };
}

/**
 * خطوطٌ استدلالية تُرسم فوق الصورة في التراكب والمقارنة — لكلتا الحالتين.
 *
 * مجموعة قياسية من خطوط التشخيح السريري: قاعدة الجمجمة والفكان والخط الوجهي،
 * فترى العين في ثانيةٍ ما يقوله الجدول بالأرقام. كل خط باسم معلميه — والمعلم
 * الغائب يسقط خطّه بصمت لا يُرسم خطأً.
 */
export const REFERENCE_LINES: [LandmarkCode, LandmarkCode, string][] = [
  ["S", "N", "SN — قاعدة الجمجمة"],
  ["ANS", "PNS", "ANS-PNS — مستوى الفك العلوي"],
  ["Me", "Go", "Me-Go — جسم الفك السفلي"],
  ["N", "Pog", "N-Pog — الخط الوجهي"],
  ["N", "A", "NA"],
  ["N", "B", "NB"],
  ["U1", "L1", "U1-L1 — القواطع"],
  ["Pog", "Go", "Pog-Go"],
];

/** يبني خطوط التحليل من معالمه — لرسمها في SVG. */
export function referenceLines(points: LandmarkMap) {
  const lines: { from: { x: number; y: number }; to: { x: number; y: number }; label: string }[] = [];
  for (const [a, b, label] of REFERENCE_LINES) {
    const from = points[a];
    const to = points[b];
    if (!isFiniteCephPoint(from) || !isFiniteCephPoint(to) || (from.x === to.x && from.y === to.y)) continue;
    lines.push({ from, to, label });
  }
  return lines;
}

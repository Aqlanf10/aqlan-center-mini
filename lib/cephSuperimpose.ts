import type { LandmarkCode, LandmarkMap } from "./ceph";

/**
 * التراكب — رسمُ تحليلين فوق بعضهما لتُرى الحركة بالعين.
 * (فكرة ومَخرَج مستودع الوكيل الآخر aqlan-center-main، معاد كتابته لنظام
 * إحداثياتنا: **بكسل الصورة الطبيعي + ملم/بكسل** لا كسورًا ونسب أبعاد.)
 *
 * الجدول يقول «SNA نزل ستّ درجات»؛ والتراكب يُري **أين تحرّك الوجه** — أنزل
 * الفكّ العلوي أم دار؟ أدارت الذقن للأمام أم نمت؟ وهذا ما يُقرأ في ثانية ولا
 * يُقرأ من عمودٍ من الأرقام.
 *
 * ### التسجيل: على قاعدة الجمجمة SN عند S
 *
 * وهي التراكب «العام» الكلاسيكي: تُثبَّت الصورتان على خطّ S→N ويُطابَق موضع S،
 * فما تحرّك بعد ذلك تحرّك فعلًا. واخترناها لأن معلميها (S وN) مطلوبان في كل
 * تتبّع — فتعمل على كل تحليل، بخلاف تراكب الفكّ العلوي الذي يحتاج ANS وPNS.
 *
 * ### وقاعدةُ القياس هي الحدّ الحاكم
 *
 * معالمنا ببكسلٍ طبيعي، فكلٌّ من التحليلين في فضائه الخاص: مختلفُ الأبعاد
 * ومختلفُ `mm_per_pixel`. فالحساب يجري في **فضاء المليمتر** — وهو المشترك الوحيد
 * الصادق بين الصورتين — ثم يُعاد الرسم ببكسل الصورة الأولى.
 *
 *   **لا تراكب بلا معايرةٍ على التحليلين معًا.**
 *
 * وقد يُغرى المرء بالتحجيم على طول SN حتى تتطابق الصورتان — وهذا **يمحو النموّ**:
 * قاعدة الجمجمة تطول في الطفل، فجعلُ طولها واحدًا في الصورتين يُلغي بالضبط ما
 * جاء التراكب ليُظهره. فلا تحجيم هنا أصلًا: المليمتر وحدةٌ واحدة في الرسمين.
 */

export interface SuperimposeInput {
  /** المعالم ببكسل الصورة الطبيعي. */
  points: LandmarkMap;
  /** ملم/بكسل لهذه الصورة — من معايرتها. */
  mmPerPixel: number | null;
}

export interface Superimposition {
  /** معالمُ التحليل الأحدث منقولةً إلى بكسل صورة الأقدم — تُرسم على صورتها. */
  points: LandmarkMap;
  /** طوله بالمليمتر في كلٍّ — فيُرى نموّ قاعدة الجمجمة رقمًا لا رسمًا فقط. */
  cranialBaseBefore: number;
  cranialBaseAfter: number;
  /** ما دار به الأحدث ليستقيم على SN الأقدم — بالدرجات. */
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

/**
 * يضع التحليل الأحدث على الأقدم.
 *
 * والترتيب معنيّ: `base` هي الأقدم التي تبقى مكانها وتُرسم عليها صورتها،
 * و`target` هي الأحدث التي تُنقل. والمستدعي هو من يرتّبهما زمنيًا.
 */
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

  const bs = toMm(baseS, base.mmPerPixel);
  const bn = toMm(baseN, base.mmPerPixel);
  const ts = toMm(targetS, target.mmPerPixel);
  const tn = toMm(targetN, target.mmPerPixel);

  const baseAngle = Math.atan2(bn.y - bs.y, bn.x - bs.x);
  const targetAngle = Math.atan2(tn.y - ts.y, tn.x - ts.x);
  const rotation = baseAngle - targetAngle;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const moved: LandmarkMap = {};
  for (const [code, point] of Object.entries(target.points)) {
    if (!point) continue;
    const p = toMm(point, target.mmPerPixel);
    // الإزاحة إلى S، ثم الدوران، ثم الوضع عند S الأقدم — كله بالمليمتر.
    const dx = p.x - ts.x;
    const dy = p.y - ts.y;
    moved[code as LandmarkCode] = toBasePx(
      { x: bs.x + dx * cos - dy * sin, y: bs.y + dx * sin + dy * cos },
      base.mmPerPixel,
    );
  }

  const spanOf = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    Math.hypot(to.x - from.x, to.y - from.y);

  return {
    ok: true,
    value: {
      points: moved,
      // بالمليمتر لا بالبكسل — فرقُ الطولين هو نموّ قاعدة الجمجمة، ويُقرأ رقمًا.
      cranialBaseBefore: spanOf(bs, bn),
      cranialBaseAfter: spanOf(ts, tn),
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
    if (!from || !to) continue;
    lines.push({ from, to, label });
  }
  return lines;
}

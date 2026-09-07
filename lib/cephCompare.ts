import type { MeasurementResult } from "./ceph";

/**
 * المقارنة بين تحليلين سيفالومتريين — قبل العلاج وبعده.
 * (منقولة من مستودع الوكيل الآخر aqlan-center-main ومكيّفة لأنواع قياساتنا.)
 *
 * وهذا ما يخرج من الوحدة إلى القرار السريري: التحليل الواحد يقول **أين المريض
 * من المعيار**، والمقارنة تقول **ماذا فعل العلاج** — وهو السؤال الذي يُسأل في
 * نهاية علاجٍ امتدّ سنتين، وأمام مريضٍ يسأل «هل تحسّنت؟».
 *
 * ### قاعدتان تحكمان هذا الملف
 *
 * ١) **لا يُقارَن إلا ما قيس في الاثنتين.** قياسٌ في الأولى وحده فرقُه ليس
 *    «تحسّنًا»: نقطتُه لم تُوضع في الثانية. وعرضُه على أنه صفرٌ أو «−» في عمود
 *    الفرق يجعل الطبيب يقرأ غيابًا على أنه ثبات.
 *
 * ٢) **«تحسّن» و«تراجع» يُحسبان بالاقتراب من المعيار لا باتجاه الرقم.** SNA
 *    ينزل من ٩٠ إلى ٨٤ تحسّنٌ، وينزل من ٨٢ إلى ٧٦ تراجع — والاتجاه واحد. فمن
 *    يقرأ سهمًا لأسفل على أنه تحسّنٌ دائمًا يقرأ نصف الحالات مقلوبة.
 *    وبلا معيارٍ للقياس لا يُحكم: يُعرض الفرق ويُقال «بلا معيار».
 */

/**
 * ما لم يتجاوز هذا لا يُسمّى تغيّرًا: ضجيجُ وضعِ نقطةٍ باليد لا أثرُ علاج.
 *
 * والمساواة تُحسب ثباتًا لا تحسّنًا: نصفُ درجةٍ بالضبط دون قدرة الإنسان على وضع
 * معلمٍ مرّتين في الموضع نفسه، وتسميتُها «تحسّنًا» ادّعاءٌ فوق ما تُثبته الأداة.
 */
export const NOISE_FLOOR = 0.5;

export type ChangeDirection = "improved" | "worsened" | "steady" | "ungraded";

export const CHANGE_LABEL: Record<ChangeDirection, { ar: string; en: string }> = {
  improved: { ar: "اقترب من المعيار", en: "Moved toward norm" },
  worsened: { ar: "ابتعد عن المعيار", en: "Moved away from norm" },
  steady: { ar: "بلا تغيّر يُذكر", en: "No meaningful change" },
  ungraded: { ar: "بلا معيار — يُقرأ ولا يُحكم", en: "No norm — read, not graded" },
};

export interface ComparedMeasurement {
  key: string;
  name: string;
  unit: string;
  before: number;
  after: number;
  /** بعد ناقص قبل — بإشارته، كما هو لا كما يُشتهى. */
  delta: number;
  /** المسافة إلى المتوسط قبل وبعد — وعليهما يُبنى الحكم. */
  gapBefore: number | null;
  gapAfter: number | null;
  direction: ChangeDirection;
}

export interface Comparison {
  measurements: ComparedMeasurement[];
  /** ما قيس في واحدةٍ فقط — يُقال بالاسم ولا يُقارَن. */
  onlyBefore: string[];
  onlyAfter: string[];
  improved: number;
  worsened: number;
  steady: number;
}

/** قياسٌ جاهز للمقارنة: قيمة رقمية + متوسط معياري (قد يغيب). */
export interface ComparableMeasurement {
  code: string;
  name: string;
  unit: string;
  value: number;
  mean: number | null;
}

/** يحوّل نتيجة قياس من محرك السيفالو إلى الشكل القابل للمقارنة. */
export function comparable(result: MeasurementResult): ComparableMeasurement | null {
  if (result.value == null || !Number.isFinite(result.value)) return null;
  return {
    code: result.code,
    name: result.ar,
    unit: result.unit,
    value: result.value,
    mean: Number.isFinite(result.mean) ? result.mean : null,
  };
}

function gapTo(measurement: ComparableMeasurement): number | null {
  return measurement.mean != null ? measurement.value - measurement.mean : null;
}

/**
 * حكمُ التغيّر — بالاقتراب من المعيار.
 *
 * وتساوي المسافتين بإشارتين مختلفتين (‎+2‎ ثم ‎−2‎) ليس ثباتًا: القيمة عبرت
 * المتوسط إلى الجهة الأخرى بالمقدار نفسه. فيُحكم بالمقدار المطلق، ويبقى الفرق
 * معروضًا بإشارته ليُرى أنها عبرت.
 */
export function directionOf(
  gapBefore: number | null, gapAfter: number | null, delta: number,
): ChangeDirection {
  if (gapBefore === null || gapAfter === null) return "ungraded";
  if (Math.abs(delta) <= NOISE_FLOOR) return "steady";
  const closer = Math.abs(gapAfter) - Math.abs(gapBefore);
  if (Math.abs(closer) <= NOISE_FLOOR) return "steady";
  return closer < 0 ? "improved" : "worsened";
}

/**
 * يقارن تحليلين.
 *
 * والترتيب مقصود: `before` هي الأقدم و`after` الأحدث. وقلبُهما يقلب كل إشارة
 * وكل حكم — فالمستدعي هو من يرتّب، والشاشة تُظهر تاريخ كلٍّ منهما صراحةً.
 */
export function compareAnalyses(
  before: readonly ComparableMeasurement[],
  after: readonly ComparableMeasurement[],
): Comparison {
  const beforeBy = new Map(before.map((item) => [item.code, item]));
  const afterBy = new Map(after.map((item) => [item.code, item]));

  const measurements: ComparedMeasurement[] = [];
  for (const [code, first] of beforeBy) {
    const second = afterBy.get(code);
    if (!second) continue;
    const gapBefore = gapTo(first);
    const gapAfter = gapTo(second);
    const delta = second.value - first.value;
    measurements.push({
      key: code,
      name: second.name,
      unit: second.unit,
      before: first.value,
      after: second.value,
      delta,
      gapBefore,
      gapAfter,
      direction: directionOf(gapBefore, gapAfter, delta),
    });
  }

  return {
    measurements,
    onlyBefore: [...beforeBy.keys()].filter((code) => !afterBy.has(code)),
    onlyAfter: [...afterBy.keys()].filter((code) => !beforeBy.has(code)),
    improved: measurements.filter((item) => item.direction === "improved").length,
    worsened: measurements.filter((item) => item.direction === "worsened").length,
    steady: measurements.filter((item) => item.direction === "steady").length,
  };
}

/**
 * جملةٌ واحدة تلخّص المقارنة.
 *
 * ولا تقول «تحسّن العلاج»: هي تعدّ قياساتٍ اقتربت وأخرى ابتعدت، والحكمُ على
 * العلاج للطبيب. وجملةٌ تحكم بدل الطبيب في ورقةٍ تُعطى لمريض تجاوزٌ لحدّ الأداة.
 */
export function comparisonSummary(comparison: Comparison): { ar: string; en: string } {
  const { improved, worsened, steady } = comparison;
  if (comparison.measurements.length === 0) {
    return {
      ar: "لا قياسَ مشتركًا بين التحليلين — لا يُقارَنان.",
      en: "The two analyses share no measurement — they cannot be compared.",
    };
  }
  return {
    ar: `${improved} قياسًا اقترب من معياره، و${worsened} ابتعد، و${steady} بلا تغيّر يُذكر.`,
    en: `${improved} measurements moved toward norm, ${worsened} away, ${steady} unchanged.`,
  };
}

export interface OrderableStudy {
  id: number;
  /** تاريخ تصوير الشععة `YYYY-MM-DD` — أو `null`/غائب فيُستخدم تاريخ الإنشاء. */
  takenOn?: string | null;
  createdAt: string;
}

/**
 * أيّهما «قبل» وأيّهما «بعد» — بترتيبٍ حاسمٍ لا يتبع من نادى.
 * (مكيّف لتحليلاتنا: بلا إصدارات مراجعة، فالمعرّف هو الحسم الأخير.)
 *
 * والتفصيل الزمني: تاريخ التصوير، ثم تاريخ الإنشاء، ثم المعرّف. وآخرُها لا
 * يتساوى أبدًا — فالترتيب حاسمٌ دائمًا، ولا يبقى شيءٌ لمن نادى.
 */
export function chronologicalOrder<T extends OrderableStudy>(one: T, two: T): [T, T] {
  const day = (study: T) => (study.takenOn ?? study.createdAt.slice(0, 10));
  const keys = (study: T): [string, string, number] =>
    [day(study), study.createdAt, study.id];

  const [a, b] = [keys(one), keys(two)];
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] === b[index]) continue;
    return a[index] < b[index] ? [one, two] : [two, one];
  }
  return [one, two];
}

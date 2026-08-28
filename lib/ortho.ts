import { addDays } from "./schedule";

/**
 * التقويم — المنطق الخالص.
 *
 * هذه الوحدة هي سبب وجود البرنامج: صاحب المركز أخصائي تقويم، وأكثر مرضاه مرضى
 * تقويم. وحالة التقويم تختلف عن أي علاج آخر في السجل بثلاثة أمور تحكم التصميم:
 *
 * ١) **تمتدّ سنتين لا زيارةً واحدة.** فالسؤال ليس «ماذا عُمل اليوم» بل «أين نحن من
 *    الخطة»: في أيّ مرحلة، وكم مضى، وكم بقي.
 * ٢) **تتقدّم بالأسلاك.** تسلسل الأسلاك هو خطّ سير العلاج، ومعرفةُ السلك الحالي في
 *    كل فكّ أول ما يحتاجه الطبيب على الكرسي — قبل أن يفتح فم المريض.
 * ٣) **تُدفع بالأقساط** مع زيارات الشدّ، وهو ما تتكفّل به خطة العلاج.
 *
 * والسؤال الذي تجيب عنه هذه الوحدة في ثلاث ثوانٍ على الكرسي: **على أيّ سلكٍ هو،
 * وماذا عُمل له آخر مرة، ومتى أراه؟**
 */

/* ─────────────────────────── الجهاز والفكّان ─────────────────────────── */

export type Appliance = "fixed_metal" | "fixed_ceramic" | "aligners" | "removable" | "functional";

export const APPLIANCE_LABEL: Record<Appliance, string> = {
  fixed_metal: "ثابت معدني",
  fixed_ceramic: "ثابت خزفي",
  aligners: "شفّاف متحرّك",
  removable: "متحرّك",
  functional: "وظيفي",
};

/** الجهاز الثابت وحده هو الذي تُتابَع أسلاكه — والمتحرّك يُتابع بخطواته. */
export function usesArchwires(appliance: Appliance): boolean {
  return appliance === "fixed_metal" || appliance === "fixed_ceramic";
}

export type Arches = "upper" | "lower" | "both";

export const ARCHES_LABEL: Record<Arches, string> = {
  upper: "الفك العلوي",
  lower: "الفك السفلي",
  both: "الفكّان",
};

/* ─────────────────────────── مراحل العلاج ─────────────────────────── */

/**
 * المراحل الأربع.
 *
 * وليست تصنيفًا إداريًّا: لكل مرحلة سلكُها وهدفُها، والخلطُ بينها هو ما يجعل العلاج
 * يطول بلا سبب — كإغلاق فراغٍ على سلكٍ مرن ينتج «تأثير الحبل» فتميل الأسنان بدل
 * أن تنتقل.
 */
export type OrthoPhase = "aligning" | "working" | "finishing" | "retention";

export const PHASE_LABEL: Record<OrthoPhase, string> = {
  aligning: "التسوية والمحاذاة",
  working: "المرحلة العاملة",
  finishing: "الإنهاء",
  retention: "التثبيت",
};

export const PHASE_HINT: Record<OrthoPhase, string> = {
  aligning: "فكّ الازدحام وتسوية المستوى — أسلاك مرنة",
  working: "إغلاق الفراغات وتصحيح العلاقة — أسلاك فولاذية مستطيلة",
  finishing: "التفاصيل والإطباق النهائي",
  retention: "بعد فكّ الجهاز — المثبّتات والمتابعة",
};

export const PHASE_ORDER: OrthoPhase[] = ["aligning", "working", "finishing", "retention"];

export type CaseStatus = "active" | "retention" | "completed" | "discontinued";

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  active: "جارية",
  retention: "تثبيت",
  completed: "مكتملة",
  discontinued: "متوقّفة",
};

/* ─────────────────────────── الأسلاك ─────────────────────────── */

export type SlotSize = "018" | "022";

export const SLOT_LABEL: Record<SlotSize, string> = {
  "018": "شقّ 0.018",
  "022": "شقّ 0.022",
};

export interface Archwire {
  /** ما يُكتب في السجل: «016 NiTi». */
  code: string;
  material: "NiTi" | "SS" | "TMA" | "CuNiTi";
  /** مستديرٌ أم مستطيل — والفرق يقرّر ما يستطيع السلك تحريكه. */
  round: boolean;
  phase: OrthoPhase;
}

/**
 * تسلسل الأسلاك المعتاد.
 *
 * **اقتراحٌ لا فرض.** الطبيب أخصائي، وحالةٌ بعينها قد تستدعي القفز أو الرجوع أو
 * البقاء على السلك نفسه شهرين. فالبرنامج يقترح التالي في التسلسل ليوفّر النقرات
 * في الحالة الغالبة، ويقبل أي سلكٍ يختاره الطبيب بلا اعتراض.
 *
 * والترتيب من الأمرن إلى الأصلب: يبدأ بمستديرٍ فائق المرونة يفكّ الازدحام بقوةٍ
 * خفيفة مستمرة، وينتهي بمستطيلٍ فولاذي يملأ الشقّ فيتحكّم في ميل الجذور — وهو ما
 * لا يستطيعه المرن مهما طال.
 */
export const WIRE_SEQUENCE: Record<SlotSize, Archwire[]> = {
  "022": [
    { code: "012 NiTi", material: "NiTi", round: true, phase: "aligning" },
    { code: "014 NiTi", material: "NiTi", round: true, phase: "aligning" },
    { code: "016 NiTi", material: "NiTi", round: true, phase: "aligning" },
    { code: "016×022 NiTi", material: "NiTi", round: false, phase: "aligning" },
    { code: "017×025 NiTi", material: "NiTi", round: false, phase: "working" },
    { code: "019×025 NiTi", material: "NiTi", round: false, phase: "working" },
    { code: "019×025 SS", material: "SS", round: false, phase: "working" },
    { code: "019×025 TMA", material: "TMA", round: false, phase: "finishing" },
  ],
  "018": [
    { code: "012 NiTi", material: "NiTi", round: true, phase: "aligning" },
    { code: "014 NiTi", material: "NiTi", round: true, phase: "aligning" },
    { code: "016 NiTi", material: "NiTi", round: true, phase: "aligning" },
    { code: "016×022 NiTi", material: "NiTi", round: false, phase: "working" },
    { code: "016×022 SS", material: "SS", round: false, phase: "working" },
    { code: "017×025 TMA", material: "TMA", round: false, phase: "finishing" },
  ],
};

export function wiresFor(slot: SlotSize): Archwire[] {
  return WIRE_SEQUENCE[slot] ?? WIRE_SEQUENCE["022"];
}

export function findWire(slot: SlotSize, code: string): Archwire | null {
  return wiresFor(slot).find((wire) => wire.code === code) ?? null;
}

/**
 * السلك التالي في التسلسل.
 *
 * يُعيد `null` عند آخر السلسلة — ولا يدور إلى أولها: العودة إلى سلكٍ مرنٍ بعد
 * الفولاذي قرارٌ سريري يُتّخذ عمدًا، لا اقتراحٌ يقدّمه برنامج.
 */
export function nextWire(slot: SlotSize, current: string | null): Archwire | null {
  const wires = wiresFor(slot);
  if (!current) return wires[0] ?? null;
  const index = wires.findIndex((wire) => wire.code === current);
  if (index < 0) return null;
  return wires[index + 1] ?? null;
}

/* ─────────────────────────── المطاطات ─────────────────────────── */

export type ElasticClass = "none" | "class_ii" | "class_iii" | "vertical" | "triangle" | "cross";

export const ELASTIC_LABEL: Record<ElasticClass, string> = {
  none: "بلا مطاطات",
  class_ii: "صنف ثانٍ",
  class_iii: "صنف ثالث",
  vertical: "عمودية",
  triangle: "مثلّثة",
  cross: "متصالبة",
};

export function isElasticClass(value: unknown): value is ElasticClass {
  return typeof value === "string" && value in ELASTIC_LABEL;
}

/* ─────────────────────────── التقدّم ─────────────────────────── */

export interface CaseProgress {
  monthsElapsed: number;
  monthsPlanned: number;
  monthsRemaining: number;
  /** نسبةٌ للعرض فقط — والعلاج لا يسير بالتقويم الزمني وحده. */
  percent: number;
  /** تجاوزت المدة المتوقعة: ليس خطأً، لكنه يستحقّ النظر. */
  overdue: boolean;
  adjustments: number;
  lastAdjustment: string | null;
  /** أيام منذ آخر شدّ — والانقطاع الطويل يُطيل العلاج ويفكّ ما أُنجز. */
  daysSinceLast: number | null;
}

const MONTH = 30.44;

export function caseProgress(input: {
  startDate: string;
  plannedMonths: number;
  adjustments: number;
  lastAdjustmentDate: string | null;
  today: string;
}): CaseProgress {
  const days = daysBetween(input.startDate, input.today);
  const monthsElapsed = Math.max(0, Math.round((days / MONTH) * 10) / 10);
  const monthsPlanned = Math.max(0, input.plannedMonths);
  const monthsRemaining = Math.max(0, Math.round((monthsPlanned - monthsElapsed) * 10) / 10);

  return {
    monthsElapsed,
    monthsPlanned,
    monthsRemaining,
    percent: monthsPlanned > 0
      ? Math.min(100, Math.round((monthsElapsed / monthsPlanned) * 100)) : 0,
    overdue: monthsPlanned > 0 && monthsElapsed > monthsPlanned,
    adjustments: input.adjustments,
    lastAdjustment: input.lastAdjustmentDate,
    daysSinceLast: input.lastAdjustmentDate
      ? daysBetween(input.lastAdjustmentDate, input.today) : null,
  };
}

/** فرقُ الأيام بين تاريخين بصيغة `YYYY-MM-DD` — بلا مناطق زمنية ولا انزياح. */
export function daysBetween(from: string, to: string): number {
  const start = Date.UTC(
    Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const end = Date.UTC(
    Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((end - start) / 86_400_000);
}

/**
 * موعد الشدّ القادم.
 *
 * أربعة أسابيع هي المعتاد لأنها مدة دورة إعادة البناء العظمي: الشدّ قبلها لا يزيد
 * الحركة بل يزيد الألم وارتشاف الجذور، وتأخيرها يترك السلك خاملًا بلا فائدة.
 */
export function nextAdjustmentDate(lastDate: string, everyWeeks = 4): string {
  return addDays(lastDate, Math.max(1, Math.round(everyWeeks)) * 7);
}

/**
 * هل تأخّر المريض عن الشدّ؟
 *
 * التأخّر في التقويم ليس كالتأخّر في غيره: الجهاز يبقى في الفم يعمل بلا إشراف،
 * وسلكٌ نُسي شهورًا قد يفكّ ما أُنجز أو يُتلف الجذور. فالتذكير هنا علاجٌ لا تسويق.
 */
export function isOverdueForAdjustment(input: {
  lastAdjustmentDate: string | null;
  startDate: string;
  today: string;
  everyWeeks?: number;
  graceDays?: number;
}): boolean {
  const since = input.lastAdjustmentDate ?? input.startDate;
  const due = nextAdjustmentDate(since, input.everyWeeks ?? 4);
  return daysBetween(due, input.today) > (input.graceDays ?? 7);
}

/* ─────────────────────────── التثبيت ─────────────────────────── */

export type RetainerType = "hawley" | "essix" | "bonded" | "none";

export const RETAINER_LABEL: Record<RetainerType, string> = {
  hawley: "هاولي متحرّك",
  essix: "شفّاف حراري",
  bonded: "ثابت ملصق",
  none: "لم يُسلَّم بعد",
};

/**
 * هل تصلح الحالة للإغلاق؟
 *
 * حالةٌ تُغلق بلا مثبّت هي أكثر ما يُفسد نتيجة سنتين: الأسنان ترتدّ، ويعود المريض
 * بعد عامٍ فيجد النتيجة ضاعت — فيلوم المركز بحق. فالإغلاق يشترط تسجيل المثبّت،
 * ويجوز أن يكون «لم يُسلَّم» بقرارٍ صريح لا بالنسيان.
 */
export function canComplete(input: {
  status: CaseStatus;
  retainer: RetainerType | null;
}): { ok: true } | { ok: false; message: string } {
  if (input.status === "completed") return { ok: false, message: "الحالة مكتملة سلفًا." };
  if (input.status === "discontinued") return { ok: false, message: "الحالة متوقّفة." };
  if (!input.retainer) {
    return { ok: false, message: "سجّل المثبّت قبل إغلاق الحالة — الارتداد يُضيع نتيجة سنتين." };
  }
  return { ok: true };
}

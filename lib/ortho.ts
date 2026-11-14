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

export type Appliance = "fixed_metal" | "fixed_ceramic" | "self_ligating_metal" | "self_ligating_ceramic"
  | "lingual" | "sapphire" | "aligners" | "removable" | "functional";

/** Saved values keep their meaning: new types are only added (owner, #483 2026-11-13), never renamed. */
export const APPLIANCE_LABEL: Record<Appliance, string> = {
  fixed_metal: "ثابت معدني",
  fixed_ceramic: "ثابت خزفي",
  self_ligating_metal: "ثابت ذاتي الربط معدني",
  self_ligating_ceramic: "ثابت ذاتي الربط خزفي",
  lingual: "ثابت لساني",
  sapphire: "ثابت سافاير",
  aligners: "شفّاف متحرّك",
  removable: "متحرّك",
  functional: "وظيفي",
};

const ARCHWIRE_APPLIANCES: ReadonlySet<Appliance> = new Set([
  "fixed_metal", "fixed_ceramic", "self_ligating_metal", "self_ligating_ceramic", "lingual", "sapphire",
]);

/** الجهاز الثابت وحده هو الذي تُتابَع أسلاكه — والمتحرّك يُتابع بخطواته. */
export function usesArchwires(appliance: Appliance | null): boolean {
  return appliance !== null && ARCHWIRE_APPLIANCES.has(appliance);
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
export type OrthoPhase = "assessment" | "aligning" | "working" | "finishing" | "retention";

export const PHASE_LABEL: Record<OrthoPhase, string> = {
  assessment: "التقييم قبل بدء العلاج",
  aligning: "التسوية والمحاذاة",
  working: "المرحلة العاملة",
  finishing: "الإنهاء",
  retention: "التثبيت",
};

export const PHASE_HINT: Record<OrthoPhase, string> = {
  assessment: "التقييم قبل بدء العلاج",
  aligning: "فكّ الازدحام وتسوية المستوى — أسلاك مرنة",
  working: "إغلاق الفراغات وتصحيح العلاقة — أسلاك فولاذية مستطيلة",
  finishing: "التفاصيل والإطباق النهائي",
  retention: "بعد فكّ الجهاز — المثبّتات والمتابعة",
};

export const PHASE_ORDER: OrthoPhase[] = ["aligning", "working", "finishing", "retention"];

export type CaseStatus = "assessment" | "active" | "retention" | "completed" | "discontinued";

/** M2 slice 29: a case summary only, not the clinical history, imaging or funding record. */
export interface OrthoCaseSummary {
  id: number;
  patientId: number;
  patientName: string;
  /** Null for an assessment-only case (staging 0108): nothing is invented before treatment starts. */
  appliance: Appliance | null;
  arches: Arches | null;
  status: CaseStatus;
  phase: OrthoPhase;
  startDate: string | null;
  plannedMonths: number | null;
  upperWire: string | null;
  lowerWire: string | null;
  responsibleDoctorId: number | null;
  responsibleDoctorName: string | null;
  baselineKind: "legacy" | null;
}
export interface OrthoCaseSummaryFeed {
  cases: OrthoCaseSummary[];
  today: string;
  hasMore: boolean;
  projection: "case-summary";
}

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  assessment: "قيد التقييم",
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

/**
 * The full wire list offered in the adjustment session (owner, #483 2026-11-13). It is a list of choices
 * only: the slot's usual sequence (WIRE_SEQUENCE) and the "next wire" suggestion are unchanged, nothing
 * is moved or rewritten automatically, and any saved code outside this list stays valid as written.
 */
export const ARCHWIRE_CATALOG: readonly { id: string; label: string; codes: readonly string[] }[] = [
  { id: "niti-round", label: "NiTi مستدير", codes: ["012 NiTi", "013 NiTi", "014 NiTi", "016 NiTi", "018 NiTi"] },
  { id: "niti-rect", label: "NiTi مستطيل", codes: ["016×016 NiTi", "016×022 NiTi", "017×025 NiTi", "018×025 NiTi", "019×025 NiTi"] },
  { id: "heat-niti", label: "NiTi حراري التنشيط", codes: ["014 HA NiTi", "016 HA NiTi", "016×022 HA NiTi", "017×025 HA NiTi", "019×025 HA NiTi"] },
  { id: "cuniti", label: "CuNiTi", codes: ["014 CuNiTi", "016 CuNiTi", "016×022 CuNiTi", "017×025 CuNiTi", "019×025 CuNiTi"] },
  { id: "ss-round", label: "فولاذ مستدير SS", codes: ["014 SS", "016 SS", "018 SS", "020 SS"] },
  { id: "ss-rect", label: "فولاذ مستطيل SS", codes: ["016×022 SS", "017×025 SS", "018×025 SS", "019×025 SS"] },
  { id: "tma", label: "TMA", codes: ["016×022 TMA", "017×025 TMA", "019×025 TMA"] },
  { id: "braided", label: "مضفور ومحوري", codes: ["0175 Braided SS", "015 Coaxial", "019×025 Braided SS"] },
];

/** Session choices: the slot's sequence first, then the catalog, then any recorded code outside both. */
export function archwireChoices(slot: SlotSize | null, recorded: readonly (string | null | undefined)[]) {
  const sequence = wiresFor(slot).map((wire) => wire.code);
  const shown = new Set(sequence);
  const groups = ARCHWIRE_CATALOG.map((group) => ({ id: group.id, label: group.label, codes: group.codes.filter((code) => !shown.has(code)) }))
    .filter((group) => group.codes.length > 0);
  for (const group of groups) for (const code of group.codes) shown.add(code);
  const other = [...new Set(recorded.filter((code): code is string => typeof code === "string" && code.trim() !== "" && !shown.has(code)))];
  return { sequence, groups, recorded: other };
}

export function wiresFor(slot: SlotSize | null): Archwire[] {
  return slot === null ? [] : WIRE_SEQUENCE[slot] ?? WIRE_SEQUENCE["022"];
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
export function nextWire(slot: SlotSize | null, current: string | null): Archwire | null {
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

/* ─────────────────────────── السيفالومتري ومراحل التشخيص التقويمي ─────────────────────────── */

export type CephDiagnosticStage = "pretreatment" | "during" | "posttreatment" | "followup";

export interface CephStageInfo {
  tCode: "T1" | "T2" | "T3" | "T4";
  labelAr: string;
  descAr: string;
  hintAr: string;
}

export const CEPH_DIAGNOSTIC_STAGES: Record<CephDiagnosticStage, CephStageInfo> = {
  pretreatment: {
    tCode: "T1",
    labelAr: "قبل العلاج (T1)",
    descAr: "التشخيص الهيكلي الأولي وتحديد خطة العلاج والميكانيكا الحيوية",
    hintAr: "قياس العلاقات الفكية وزوايا القواطع قبل تركيب أي حاصرات تقويمية",
  },
  during: {
    tCode: "T2",
    labelAr: "أثناء العلاج والتقدم (T2)",
    descAr: "تقييم حركة الجذور وتقدم الحالة واستجابة الفكين",
    hintAr: "يُجرى عادةً بنهاية مرحلة التسوية والمحاذاة أو قبل إغلاق المسافات",
  },
  posttreatment: {
    tCode: "T3",
    labelAr: "بعد انتهاء العلاج (T3)",
    descAr: "تقييم النتيجة النهائية وتغيرات الأنسجة الرخوة واستقرار الإطباق",
    hintAr: "يُجرى فور فك الجهاز التقويمي الثابت وقبل أو مع تسليم المثبتات",
  },
  followup: {
    tCode: "T4",
    labelAr: "المتابعة والاستبقاء (T4)",
    descAr: "مراقبة ثبات النتيجة وفحص كفاءة المثبتات ومنع الارتداد",
    hintAr: "يُجرى بعد 6 إلى 12 شهرًا من فترة التثبيت لتقييم الاستقرار طويل الأمد",
  },
};

/**
 * اقتراح مرحلة السيفالومتري المناسبة تلقائيًا بناءً على مرحلة وعدد جلسات التقويم.
 * - مرحلة البداية أو دون شدّات: T1 (ما قبل العلاج)
 * - مرحلة التسوية أو المرحلة العاملة: T2 (أثناء التقدم)
 * - مرحلة الإنهاء: T3 (بعد انتهاء العلاج)
 * - مرحلة التثبيت: T4 (المتابعة والاستبقاء)
 */
export function suggestCephPhase(
  orthoPhase?: OrthoPhase | null,
  adjustmentsCount = 0,
): CephDiagnosticStage {
  if (!orthoPhase || adjustmentsCount === 0) return "pretreatment";
  if (orthoPhase === "aligning" || orthoPhase === "working") return "during";
  if (orthoPhase === "finishing") return "posttreatment";
  if (orthoPhase === "retention") return "followup";
  return "during";
}


/** M2 slice 30: native ortho clinical data only. Financial agreements, visit
 * records/notes and documents have independent capabilities and readers. */
export interface OrthoClinicalCase extends OrthoCaseSummary {
  slot: SlotSize | null;
  bracketSystem: string | null;
  retainer: RetainerType | null;
  retainerOn: string | null;
  note: string | null;
  closedAt: string | null;
  closedNote: string | null;
  baselineRecordedAt: string | null;
  elastics: string | null;
  remainingObjectives: string | null;
}
export interface OrthoClinicalAdjustment {
  id: number;
  doneOn: string;
  phase: OrthoPhase | null;
  upperWire: string | null;
  lowerWire: string | null;
  elastics: ElasticClass;
  elasticNote: string | null;
  done: string | null;
  nextWeeks: number;
  note: string | null;
  recordedBy: string;
  /** 0132: null = not recorded; [] = explicitly none. */
  auxiliaries: string[] | null;
  auxiliaryOther: string | null;
}
export interface OrthoClinicalDetail {
  /** Server-resolved zone supplied by the canonical detail read. */
  clinicTimeZone?: string;
  /** Present on the canonical saved-detail projection; not mutation authority. */
  editVersion?: string | null;
  projection: "case-clinical";
  case: OrthoClinicalCase;
  adjustments: OrthoClinicalAdjustment[];
  hasMore: boolean;
  progress: CaseProgress | null;
  today: string;
}

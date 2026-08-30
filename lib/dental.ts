/**
 * مخطط الأسنان بالترقيم الدولي FDI — المنطق الخالص.
 *
 * الترقيم: الرقم الأول للربع (1 علوي أيمن، 2 علوي أيسر، 3 سفلي أيسر، 4 سفلي أيمن)،
 * والثاني لموضع السن من المنتصف (1 قاطع أوسط … 8 ضرس العقل).
 *
 * ولماذا FDI لا الترقيم العالمي (1–32): لأنه ما يفهمه أي طبيب أسنان في العالم، وما
 * يُكتب في تقارير المختبرات والإحالات. ونظامٌ يستعمل ترقيمًا خاصًّا به يجبر الطبيب على
 * الترجمة في رأسه عند كل إحالة — وترجمةٌ في الرأس تُخطئ يومًا.
 *
 * ويشمل الأسنان اللبنية (55–51، 61–65، 75–71، 81–85) لأن المركز يعالج أطفالًا،
 * وسنٌّ لبني يُسجَّل برقم دائم يجعل تاريخ الطفل خطأً كاملًا.
 */

export type Quadrant = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** الأرباع الدائمة بترتيب العرض: من يمين المريض إلى يساره. */
export const PERMANENT_UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
export const PERMANENT_LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
export const PRIMARY_UPPER = [55, 54, 53, 52, 51, 61, 62, 63, 64, 65];
export const PRIMARY_LOWER = [85, 84, 83, 82, 81, 71, 72, 73, 74, 75];

export const ALL_TEETH = [
  ...PERMANENT_UPPER, ...PERMANENT_LOWER, ...PRIMARY_UPPER, ...PRIMARY_LOWER,
];

export function isValidTooth(code: number): boolean {
  return ALL_TEETH.includes(code);
}

export function isPrimary(code: number): boolean {
  const quadrant = Math.floor(code / 10);
  return quadrant >= 5 && quadrant <= 8;
}

/** «الضرس الأول العلوي الأيمن» — لأن «16» وحده لا يُقرأ في تقرير للمريض. */
export function toothName(code: number): string {
  const quadrant = Math.floor(code / 10);
  const position = code % 10;
  const upper = quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6;
  const right = quadrant === 1 || quadrant === 4 || quadrant === 5 || quadrant === 8;

  const permanent = [
    "", "القاطع الأوسط", "القاطع الجانبي", "الناب", "الضاحك الأول", "الضاحك الثاني",
    "الرحى الأولى", "الرحى الثانية", "رحى العقل",
  ];
  const primary = [
    "", "القاطع الأوسط", "القاطع الجانبي", "الناب", "الرحى الأولى", "الرحى الثانية",
  ];
  const base = (isPrimary(code) ? primary : permanent)[position] ?? `السن ${code}`;
  const side = `${upper ? "العلوي" : "السفلي"} ${right ? "الأيمن" : "الأيسر"}`;
  return `${base} ${side}${isPrimary(code) ? " (لبني)" : ""}`;
}

/**
 * حالات السن.
 *
 * قائمة مغلقة عمدًا — والدستور يمنع الحالة كنصّ حرّ: «حشوة» و«حشوه» و«محشو» ثلاث
 * حالات في التقارير وواحدة في الواقع.
 */
export type ToothCondition =
  | "healthy" | "caries" | "filling" | "rct" | "crown" | "bridge"
  | "implant" | "missing" | "extracted" | "impacted" | "fracture" | "mobility"
  | "veneer" | "sealant" | "bracket";

export const CONDITION_LABEL: Record<ToothCondition, string> = {
  healthy: "سليم",
  caries: "تسوّس",
  filling: "حشوة",
  rct: "علاج عصب",
  crown: "تاج",
  bridge: "جسر",
  implant: "زرعة",
  missing: "مفقود",
  extracted: "مخلوع",
  impacted: "منطمر",
  fracture: "كسر",
  mobility: "قلقلة",
  veneer: "قشرة تجميلية",
  sealant: "مادة مانعة للتسوّس",
  bracket: "براكيت تقويم",
};

/**
 * مرحلة الحالة — والتمييز بينها هو نصف قيمة المخطط.
 *
 * `existing` ما وجده الطبيب، و`planned` ما نوى عمله، و`completed` ما أنجزه. ومخططٌ
 * لا يفرّق بينها يجعل الطبيب لا يعرف: هل هذه حشوةٌ وضعها هو أم وجدها؟ وهل هذا التاج
 * منجَز أم مجرّد خطة لم تُنفَّذ؟
 */
export type ConditionStage = "existing" | "planned" | "completed";

export const STAGE_LABEL: Record<ConditionStage, string> = {
  existing: "قائم",
  planned: "مخطَّط",
  completed: "منجَز",
};

/** الحالات التي تعني أن السن لم يعد موجودًا — تُعرض مختلفةً ولا تقبل خطة عليها. */
export const ABSENT_CONDITIONS: ToothCondition[] = ["missing", "extracted"];

export function isAbsent(condition: ToothCondition): boolean {
  return ABSENT_CONDITIONS.includes(condition);
}

export interface ToothRecord {
  id: number;
  toothCode: number;
  condition: ToothCondition;
  stage: ConditionStage;
  surfaces: string | null;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
  visitId: number | null;
}

export interface ToothState {
  toothCode: number;
  /** الحالة السارية — آخر ما ثُبّت على هذا السن. */
  current: ToothRecord | null;
  planned: ToothRecord[];
  history: ToothRecord[];
  absent: boolean;
}

/**
 * يبني حالة كل سن من سجلّه.
 *
 * **الحالة السارية هي آخر `existing` أو `completed`** لا آخر سطر مطلقًا: خطةٌ سُجّلت
 * اليوم لا تعني أن السن صار تاجًا. ولو أُخذ آخر سطر لظهر المريض وقد أُنجز له كل ما
 * خُطِّط — وهو أخطر ما يمكن أن يقوله مخطط سني.
 */
export function buildChart(records: ToothRecord[]): Map<number, ToothState> {
  const chart = new Map<number, ToothState>();
  const ordered = [...records].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id - b.id);

  for (const record of ordered) {
    const state = chart.get(record.toothCode) ?? {
      toothCode: record.toothCode, current: null, planned: [], history: [], absent: false,
    };
    state.history.push(record);
    if (record.stage === "planned") {
      state.planned.push(record);
    } else {
      state.current = record;
      state.absent = isAbsent(record.condition);
      // إنجاز ما كان مخطَّطًا يشطب الخطة: خطةٌ تبقى بعد تنفيذها تجعل الطبيب يعمل
      // العمل مرتين، والمريض يُفوتَر مرتين.
      state.planned = state.planned.filter((plan) => plan.condition !== record.condition);
    }
    chart.set(record.toothCode, state);
  }
  return chart;
}

export interface ChartSummary {
  charted: number;
  caries: number;
  planned: number;
  completed: number;
  absent: number;
}

/** ملخّصٌ يُقرأ في سطر أعلى المخطط بدل عدّ الأسنان بالعين. */
export function chartSummary(chart: Map<number, ToothState>): ChartSummary {
  let caries = 0, planned = 0, completed = 0, absent = 0;
  for (const state of chart.values()) {
    if (state.current?.condition === "caries") caries += 1;
    if (state.absent) absent += 1;
    planned += state.planned.length;
    completed += state.history.filter((row) => row.stage === "completed").length;
  }
  return { charted: chart.size, caries, planned, completed, absent };
}

/**
 * أسطح السن للحشوات: M D O B L (إنسي، وحشي، إطباقي، دهليزي، لساني).
 *
 * تُحفظ نصًّا قصيرًا مرتّبًا لا مجموعةً: «MOD» هو ما يكتبه الطبيب وما يقرؤه المختبر.
 */
export const SURFACES = ["M", "D", "O", "B", "L"] as const;

export function normalizeSurfaces(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const letters = raw.toUpperCase().split("").filter((letter) =>
    (SURFACES as readonly string[]).includes(letter));
  const unique = [...new Set(letters)];
  const ordered = SURFACES.filter((surface) => unique.includes(surface));
  return ordered.length > 0 ? ordered.join("") : null;
}

/**
 * تحويل ترقيم FDI الدولي إلى الترقيم العالمي (Universal Numbering System 1-32 / A-T).
 * المعيار المستخدم في الأنظمة العالمية مثل Dentrix و Open Dental.
 */
const FDI_TO_UNIVERSAL: Record<number, string> = {
  // الفك العلوي الدائم (1-16)
  18: "1", 17: "2", 16: "3", 15: "4", 14: "5", 13: "6", 12: "7", 11: "8",
  21: "9", 22: "10", 23: "11", 24: "12", 25: "13", 26: "14", 27: "15", 28: "16",
  // الفك السفلي الدائم (17-32)
  38: "17", 37: "18", 36: "19", 35: "20", 34: "21", 33: "22", 32: "23", 31: "24",
  41: "25", 42: "26", 43: "27", 44: "28", 45: "29", 46: "30", 47: "31", 48: "32",
  // الأسنان اللبنية (A - T)
  55: "A", 54: "B", 53: "C", 52: "D", 51: "E", 61: "F", 62: "G", 63: "H", 64: "I", 65: "J",
  75: "K", 74: "L", 73: "M", 72: "N", 71: "O", 81: "P", 82: "Q", 83: "R", 84: "S", 85: "T",
};

export function toUniversal(fdiCode: number): string {
  return FDI_TO_UNIVERSAL[fdiCode] ?? String(fdiCode);
}


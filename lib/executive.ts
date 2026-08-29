import {
  incomeStatement,
  trialBalance,
  AR_ACCOUNT,
  AP_ACCOUNT,
  CASH_ACCOUNT,
  type AccountBalance,
  type IncomeStatement,
  type JournalEntry,
} from "./accounting";
import type { Currency } from "./money";
import type { Visit } from "./flow";

/**
 * غرفة القيادة — ExecutiveKPIAggregation.
 *
 * قاعدة المنطقة E الحاكمة: **المؤشرات من حركات مدقَّقة في دفتر الأستاذ حصرًا**.
 *
 * ما يعنيه هذا عمليًا: لا دالة هنا تحسب ريالًا من جدول مدفوعات أو فواتير مباشرة.
 * المال كله يُقرأ من ميزان مراجعة مُشتق من القيود المزدوجة — وهي نفسها التي تُقرأ
 * في شاشة المحاسبة والمصدرَّة منها. فمطابقة لوحة القيادة مع الدفاتر الرسمية ليست
 * صفحة تُفحص شهريًا؛ هي نتيجة بنيوية: **لا يوجد رقم مالي هنا إلا وهو رقم دفتر**.
 *
 * والتشغيلي (الزيارات والمرضى والإشغال) ليس مالًا، فمصدره السجلات التشغيلية نفسها
 * التي تخدم شاشات اليوم — ولذلك لا يمكنه أن يخالفها.
 */

export interface CollectionsRow {
  currency: Currency;
  /** ما دخل الصندوق من تحصيل مرضى في الفترة (مدين حساب النقدية). */
  collectedMinor: number;
  /** ما خرج من الصندوق بسندات صرف في الفترة (دائن حساب النقدية). */
  paidOutMinor: number;
  /** صافي حركة الصندوق في الفترة. */
  netMinor: number;
}

export interface PartyDueRow {
  kind: string;
  label: string;
  dueMinor: number;
}

export interface ExecutiveOperational {
  arrived: number;
  done: number;
  /** زيارات ما زالت مفتوحة نهاية الفترة — العمل غير المُنهى. */
  stillOpen: number;
  noShow: number;
  cancelled: number;
  newPatients: number;
  totalPatients: number;
  orthoActive: number;
  orthoTotal: number;
  inventoryAlerts: number;
}

export interface ChairOccupancy {
  chairs: number;
  /** الأيام التي عمل فيها المركز فعلًا (يوم فيه وصول مريض واحد على الأقل). */
  activeDays: number;
  /** دقائق شغل الكراسي الفعلية — من جلوس المريض إلى انتهاء زيارته. */
  occupiedMinutes: number;
  /** السعة: كراسي × أيام عمل × ساعات اليوم. */
  capacityMinutes: number;
  /** نسبة الإشغال 0–100. */
  pct: number;
}

export interface ExecutiveKpis {
  from: string;
  to: string;
  /** عملة الدفاتر — كل مبالغ هذا الكائن بها. */
  baseCurrency: Currency;
  /** قائمة الدخل للفترة — من الدفاتر حصرًا (أساس الاستحقاق). */
  income: IncomeStatement;
  /** حركة الصندوق لكل عملة في الفترة — مدين ودائن حساب النقدية في الميزان. */
  collections: CollectionsRow[];
  /** ذمم المرضى التراكمية حتى نهاية الفترة — رصيد حساب الدفاتر 1201. */
  receivableMinor: number;
  /** ذمم المعامل والموردين التراكمية حتى نهاية الفترة — حساب الدفاتر 2101. */
  payableMinor: number;
  /** تفصيل الذمم الدائنة بحسب الجهة — الدالة نفسها التي تخدم شاشات الجهات. */
  parties: PartyDueRow[];
  operational: ExecutiveOperational;
  occupancy: ChairOccupancy;
}

export interface ExecutiveInput {
  from: string;
  to: string;
  /** عملة الدفاتر من الإعدادات. */
  baseCurrency: Currency;
  /** ميزان مراجعة الفترة (قيود الفترة وحدها). */
  periodBalances: AccountBalance[];
  /** ميزان مراجعة تراكمي حتى نهاية الفترة (كل قيود الماضي + الفترة). */
  cumulativeBalances: AccountBalance[];
  parties: PartyDueRow[];
  operational: Omit<ExecutiveOperational, keyof typeof NUMERIC_ZERO> & Partial<ExecutiveOperational>;
  occupancy: ChairOccupancy;
}

const NUMERIC_ZERO = {
  arrived: 0, done: 0, stillOpen: 0, noShow: 0, cancelled: 0,
  newPatients: 0, totalPatients: 0, orthoActive: 0, orthoTotal: 0, inventoryAlerts: 0,
} as const;

const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

const CURRENCY_LABEL: Record<Currency, string> = {
  YER: "ريال يمني", SAR: "ريال سعودي", USD: "دولار",
};

/** فصل قيود الفترة عن التراكمي — مقارنة نصية كافية فالتاريخ "YYYY-MM-DD". */
export function splitPeriod(entries: JournalEntry[], from: string): JournalEntry[] {
  return entries.filter((entry) => entry.date >= from);
}

function balanceOf(balances: AccountBalance[], code: string): AccountBalance | undefined {
  return balances.find((row) => row.code === code);
}

/** حركة الصندوق لكل عملة من ميزان الفترة: مدين دخلًا ودائن خروجًا. */
export function collectionsFromBalances(
  periodBalances: AccountBalance[],
): CollectionsRow[] {
  return CURRENCIES.map((currency) => {
    const row = balanceOf(periodBalances, CASH_ACCOUNT[currency]);
    const collectedMinor = row?.debitMinor ?? 0;
    const paidOutMinor = row?.creditMinor ?? 0;
    return {
      currency,
      collectedMinor,
      paidOutMinor,
      netMinor: collectedMinor - paidOutMinor,
    };
  });
}

/**
 * إشغال الكراسي.
 *
 * «السعة» ليست أيام التقويم: يوم الجمعة مغلق ليس كرسيًا خاملًا بل عيادة غير مفتوحة،
 * وعدّه يُخفّض النسبة رقمًا جميلًا وكاذب المعنى. السعة تُحسب على **أيام العمل
 * الفعلية** — يومٌ فيه وصول مريض واحد على الأقل — مضروبة في عدد الكراسي وساعات
 * اليوم من الإعدادات.
 *
 * ودقائق الزيارة تُقاس من الجلوس إلى الانتهاء، ويُسقّط ما لا يجلس أو لا ينتهي،
 * ويُسقّف طولُ الزيارة عند طول يوم العيادة — حمايةً من بيانات شاذة (زيارة نُسي
 * إغلاقها يومين) تُفسد النسبة كلها.
 */
export function chairOccupancy(
  visits: Visit[],
  options: { chairs: number; dayStart: string; dayEnd: string; activeDays: number },
): ChairOccupancy {
  const dayMinutes = Math.max(0, minutesOfDay(options.dayEnd) - minutesOfDay(options.dayStart));
  const occupiedMinutes = visits.reduce((sum, visit) => {
    if (visit.chair == null || !visit.seatedAt || !visit.finishedAt) return sum;
    const start = Date.parse(visit.seatedAt);
    const end = Date.parse(visit.finishedAt);
    if (Number.isNaN(start) || Number.isNaN(end)) return sum;
    const minutes = Math.round(Math.max(0, end - start) / 60_000);
    return sum + Math.min(minutes, dayMinutes || minutes);
  }, 0);
  const capacityMinutes = options.chairs * options.activeDays * dayMinutes;
  return {
    chairs: options.chairs,
    activeDays: options.activeDays,
    occupiedMinutes,
    capacityMinutes,
    pct: capacityMinutes > 0 ? Math.round((occupiedMinutes * 100) / capacityMinutes) : 0,
  };
}

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map((part) => Number.parseInt(part, 10));
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

/**
 * تجميع المؤشرات.
 *
 * كل رقم مالي يُقرأ هنا من ميزانين: ميزان الفترة (قائمة الدخل وحركة الصندوق)
 * وميزان تراكمي حتى نهاية الفترة (الذمم). لا وسيط ولا إعادة جمع — فأي إعادة
 * جمع في مكان آخر هي البذرة التي تُنبت تضاربًا بين شاشة وتقرير.
 */
export function executiveKpis(input: ExecutiveInput): ExecutiveKpis {
  const income = incomeStatement(input.periodBalances);
  const receivableMinor = balanceOf(input.cumulativeBalances, AR_ACCOUNT)?.balanceMinor ?? 0;
  const payableMinor = balanceOf(input.cumulativeBalances, AP_ACCOUNT)?.balanceMinor ?? 0;
  const operational: ExecutiveOperational = { ...NUMERIC_ZERO, ...input.operational };

  return {
    from: input.from,
    to: input.to,
    baseCurrency: input.baseCurrency,
    income,
    collections: collectionsFromBalances(input.periodBalances),
    receivableMinor,
    payableMinor,
    parties: input.parties,
    operational,
    occupancy: input.occupancy,
  };
}

// ── مركز التقارير الموحّد ────────────────────────────────────────────────────

/**
 * تصدير CSV لغرفة القيادة.
 *
 * قاعدة كيان DomainReportingService: **استحالة تضارب أرقام الشاشة مع الأرقام
 * المصدَّرة**. لذلك لا يستعلم هذا التصدير عن شيء — يأخذ الكائن نفسه الذي تُعرضه
 * الشاشة ويُسطّره سطرًا سطرًا. ما تراه الشاشة هو ما يخرج في الملف حرفيًا.
 *
 * المبالغ بوحداتها الصغرى كما في الدفاتر: إعادة جمعها في Excel أو برنامج محاسبي
 * آخر تعطي الأرقام نفسها بلا تقريب، وتصفية العملة صريحة في كل سطر.
 */
export function executiveCsv(kpis: ExecutiveKpis): string {
  const rows: (string | number)[][] = [
    ["القسم", "البند", "العملة", "المبلغ (وحدات صغرى)"],
    ["الفترة", `من ${kpis.from} إلى ${kpis.to}`, "", ""],
    ["العملة الأساسية", kpis.baseCurrency, "", ""],
  ];
  const money = (section: string, label: string, currency: Currency | "", minor: number) =>
    rows.push([section, label, currency, minor]);

  money("المالية", "الإيرادات", "", kpis.income.revenueMinor);
  money("المالية", "الخصومات الممنوحة", "", kpis.income.discountMinor);
  money("المالية", "صافي الإيراد", "", kpis.income.netRevenueMinor);
  for (const expense of kpis.income.expenses) {
    money("المالية — مصروفات", expense.name, "", expense.amountMinor);
  }
  money("المالية", "إجمالي المصروفات", "", kpis.income.totalExpensesMinor);
  money("المالية", "صافي الربح", "", kpis.income.netProfitMinor);
  for (const row of kpis.collections) {
    money("الصندوق", `تحصيل — ${CURRENCY_LABEL[row.currency]}`, row.currency, row.collectedMinor);
    money("الصندوق", `مصروف صندوق — ${CURRENCY_LABEL[row.currency]}`, row.currency, row.paidOutMinor);
    money("الصندوق", `صافي حركة — ${CURRENCY_LABEL[row.currency]}`, row.currency, row.netMinor);
  }
  money("الذمم", "ذمم المرضى (تراكمي)", "", kpis.receivableMinor);
  money("الذمم", "ذمم المعامل والموردين (تراكمي)", "", kpis.payableMinor);
  for (const party of kpis.parties) {
    money("الذمم — تفصيل", party.label, "", party.dueMinor);
  }
  rows.push(["التشغيل", "زيارات وصلت", "", kpis.operational.arrived]);
  rows.push(["التشغيل", "زيارات منتهية", "", kpis.operational.done]);
  rows.push(["التشغيل", "زيارات مفتوحة", "", kpis.operational.stillOpen]);
  rows.push(["التشغيل", "لم يحضر", "", kpis.operational.noShow]);
  rows.push(["التشغيل", "ملغاة", "", kpis.operational.cancelled]);
  rows.push(["التشغيل", "مرضى جدد في الفترة", "", kpis.operational.newPatients]);
  rows.push(["التشغيل", "إجمالي المرضى", "", kpis.operational.totalPatients]);
  rows.push(["التشغيل", "حالات تقويم نشطة", "", kpis.operational.orthoActive]);
  rows.push(["التشغيل", "حالات تقويم إجمالًا", "", kpis.operational.orthoTotal]);
  rows.push(["التشغيل", "تنبيهات المخزون", "", kpis.operational.inventoryAlerts]);
  rows.push(["الإشغال", "كراسي", "", kpis.occupancy.chairs]);
  rows.push(["الإشغال", "أيام عمل فعلية", "", kpis.occupancy.activeDays]);
  rows.push(["الإشغال", "دقائق شغل", "", kpis.occupancy.occupiedMinutes]);
  rows.push(["الإشغال", "دقائق سعة", "", kpis.occupancy.capacityMinutes]);
  rows.push(["الإشغال", "نسبة الإشغال %", "", kpis.occupancy.pct]);
  return rows.map((row) => row.map((cell) => String(cell)).join(",")).join("\n");
}

// ── نطاقات الفترة ────────────────────────────────────────────────────────────

/** بداية الشهر — تُحسب بتوقيت جهاز العيادة كما في شاشة اليوم. */
function monthStart(date: Date, offset = 0): string {
  const d = new Date(date.getFullYear(), date.getMonth() + offset, 1);
  return isoDate(d);
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export type PeriodPreset = "thisMonth" | "lastMonth" | "last3" | "thisYear" | "lastYear";

export const PERIOD_PRESET_LABEL: Record<PeriodPreset, string> = {
  thisMonth: "هذا الشهر",
  lastMonth: "الشهر الماضي",
  last3: "آخر ٣ أشهر",
  thisYear: "السنة الحالية",
  lastYear: "السنة الماضية",
};

/**
 * نطاق الفترة الجاهز — بتوقيت جهاز العيادة لا الخادم.
 *
 * نفس القاعدة التي تحكم شاشة اليوم: الخادم بـ UTC والمركز في تعز، فقياس
 * الفترة بـ UTC يسحب مساء اليوم من الشهر ويضيفه لشهر آخر.
 */
export function periodRange(preset: PeriodPreset, today: Date): { from: string; to: string } {
  switch (preset) {
    case "thisMonth":
      return { from: monthStart(today), to: isoDate(today) };
    case "lastMonth": {
      const from = monthStart(today, -1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      return { from, to: isoDate(end) };
    }
    case "last3":
      return { from: monthStart(today, -2), to: isoDate(today) };
    case "thisYear":
      return { from: `${today.getFullYear()}-01-01`, to: isoDate(today) };
    case "lastYear":
      return { from: `${today.getFullYear() - 1}-01-01`, to: `${today.getFullYear() - 1}-12-31` };
  }
}

export { CURRENCY_LABEL as EXECUTIVE_CURRENCY_LABEL };

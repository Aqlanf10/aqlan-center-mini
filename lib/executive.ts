import {
  incomeStatement,
  AP_ACCOUNT,
  CASH_ACCOUNT,
  type AccountBalance,
  type JournalEntry,
} from "./accounting";
import type { Currency } from "./money";
import type { ExecutiveBillingRow, ExecutiveReceivableRow } from "./reports";
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
 *
 * (P-01 owner review — تصحيح ١) الدفتر المشتق نفسه يخلط عملات الفواتير الخام مع
 * مكافئات الدفعات الأساسية في حسابي الإيراد والذمم (TD-REG-028 يبقى مفتوحًا
 * لإعادة تمثيله العميق). فصارت المؤشرات المالية على مصدرين مصرَّحين:
 *
 *  - **الفواتير والذمم**: من المراجع القانونية لكل عملة — حركات محرك التقارير
 *    وأرصدة المرضى بدلائل عملاتهم — لا من الدفاتر المشتقة الممزوجة.
 *  - **الصندوق والمصروفات والذمم الدائنة**: من الدفاتر حصرًا كما كانت — قيودها
 *    أساسيةٌ خالصة فلا مزج فيها، ومحاسبة المكافئ المسجَّل تاريخيًا صحيحة.
 */

/**
 * (المراجعة النهائية للمال ١) عقد حركة الصندوق من الدفتر: **محاسبةٌ بالأساس**.
 *
 * قيد الدفعة (paymentEntry) يقيّد baseAmountMinor — المكافئ الأساسي المسجّل
 * بسعر يوم الحركة — في حساب صندوق العملة المقبوضة (1102 للسعودي، 1103
 * للدولار). فسطر الدفتر مبلغٌ **أساسي** (YER) وإن كان حسابه درجًا سعوديًا أو
 * دولاريًا: عملة الحساب هوية الدرج الذي أنتج الحركة، لا عملة المبلغ.
 *
 *  1,500.00 ر.س @130 ⇒ قيدها 195,000 ر.ي في حساب 1102 — فلا تُعرض 1,950.00
 *  ر.س أبدًا؛ و 120.00 $ @530 ⇒ 63,600 ر.ي في 1103 لا 636.00 $.
 *
 * وكل أرجل الصندوق الأخرى (المصروف النقدي، فروق الجرد، إعادة التقييم،
 * القيود اليدوية) كذلك أساسيةٌ خالصة — فالدفتر كله بعملة واحدة.
 */
export interface CashMovementRow {
  /** عملة **حساب الصندوق** الذي أنتج الحركة — هوية الدرج في الدليل، لا عملة
   *  المبلغ: كل مبالغ الصفوف بالعملة الأساسية (مكافئات مسجّلة تاريخيًا). */
  cashAccountCurrency: Currency;
  /** ما دخل حساب الصندوق في الفترة (مدينه) — بالعملة الأساسية. */
  collectedBaseMinor: number;
  /** ما خرج منه في الفترة (دائنه) — بالعملة الأساسية. */
  paidOutBaseMinor: number;
  /** صافي حركة الحساب في الفترة — بالعملة الأساسية. */
  netBaseMinor: number;
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
  /** عملة الدفاتر — مصروفات هذا الكائن وأرجل النقدية بها. */
  baseCurrency: Currency;
  /** (P-01 owner review — تصحيح ١) فواتير الفترة لكل عملة — من مرجع الفواتير
   *  القانوني بعملة كل فاتورة، لا من دفترٍ مشتق يمزج. */
  billingByCurrency: ExecutiveBillingRow[];
  /** مصروفات الفترة بأساسها المسجَّل — من قيود الدفتر الأساسية الخالصة. */
  expenses: { code: string; name: string; amountMinor: number }[];
  totalExpensesMinor: number;
  /** (المراجعة النهائية للمال ١) حركة حسابات الصندوق لكل درج في الفترة — من
   *  ميزان الفترة، وكل المبالغ بالعملة الأساسية (baseCurrency): قيود
   *  الدفعات بمكافئها الأساسي المسجَّل يوم حركتها، وعملة الحساب هوية الدرج
   *  لا عملة المبلغ — فلا يُعرض 195,000 ر.ي سعوديًّا أبدًا. المبالغ الورقية
   *  الأصلية تُقرأ من مستندات القبض والصرف لا تُشتق من الدفتر. */
  cashMovements: CashMovementRow[];
  /** (P-01 owner review — تصحيح ١) ذمم المرضى لكل عملة حتى نهاية الفترة — من
   *  مرجع أرصدة المرضى القانوني بدلائل عملاتهم، لا من دفترٍ مشتق يمزج. */
  receivableByCurrency: ExecutiveReceivableRow[];
  /** ذمم المعامل والموردين التراكمية حتى نهاية الفترة — قيودها أساسية خالصة. */
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
  /** (P-01 owner review — تصحيح ١) فواتير الفترة لكل عملة — من المرجع القانوني. */
  billingByCurrency: ExecutiveBillingRow[];
  /** (P-01 owner review — تصحيح ١) ذمم المرضى لكل عملة حتى نهاية الفترة — من
   *  المرجع القانوني. */
  receivableByCurrency: ExecutiveReceivableRow[];
  /** ميزان مراجعة الفترة (قيود الفترة وحدها) — للصندوق والمصروفات. */
  periodBalances: AccountBalance[];
  /** ميزان مراجعة تراكمي حتى نهاية الفترة — للذمم الدائنة. */
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

/** حركة الصندوق لكل حساب (درج) من ميزان الفترة: مدين دخلًا ودائن خروجًا —
 * وكلها بالعملة الأساسية (المراجعة النهائية للمال ١). */
export function cashMovementsFromBalances(
  periodBalances: AccountBalance[],
): CashMovementRow[] {
  return CURRENCIES.map((cashAccountCurrency) => {
    const row = balanceOf(periodBalances, CASH_ACCOUNT[cashAccountCurrency]);
    const collectedBaseMinor = row?.debitMinor ?? 0;
    const paidOutBaseMinor = row?.creditMinor ?? 0;
    return {
      cashAccountCurrency,
      collectedBaseMinor,
      paidOutBaseMinor,
      netBaseMinor: collectedBaseMinor - paidOutBaseMinor,
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
 * (P-01 owner review — تصحيح ١) فواتيرُ الفترة وذممُّها تُقرأ من المراجع
 * القانونية لكل عملة (مُمرَّرة من محرك التقارير)، والصندوق والمصروفات والذمم
 * الدائنة من ميزاني الدفتر كما كانت — قيودها أساسيةٌ خالصة فلا مزج. لا وسيط
 * ولا إعادة جمع — فأي إعادة جمع في مكان آخر هي البذرة التي تُنبت تضاربًا بين
 * شاشة وتقرير.
 */
export function executiveKpis(input: ExecutiveInput): ExecutiveKpis {
  // (تصحيح ١) المصروفات فقط من قائمة الدخل الدفترية — أساسٌ خالص؛ أرجل الإيراد
  // فيها ممزوجة فلا تُقرأ (TD-REG-028 لإعادة تمثيلها).
  const statement = incomeStatement(input.periodBalances);
  const payableMinor = balanceOf(input.cumulativeBalances, AP_ACCOUNT)?.balanceMinor ?? 0;
  const operational: ExecutiveOperational = { ...NUMERIC_ZERO, ...input.operational };

  return {
    from: input.from,
    to: input.to,
    baseCurrency: input.baseCurrency,
    billingByCurrency: input.billingByCurrency,
    expenses: statement.expenses,
    totalExpensesMinor: statement.totalExpensesMinor,
    cashMovements: cashMovementsFromBalances(input.periodBalances),
    receivableByCurrency: input.receivableByCurrency,
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

  // (تصحيح ١) الفواتير لكل عملة — من المرجع القانوني، لا دفترًا ممزوجًا.
  for (const row of kpis.billingByCurrency) {
    money("الفواتير", `إجمالي الفواتير — ${CURRENCY_LABEL[row.currency]}`, row.currency, row.grossMinor);
    money("الفواتير", `الخصومات الممنوحة — ${CURRENCY_LABEL[row.currency]}`, row.currency, row.discountMinor);
    money("الفواتير", `صافي الفواتير — ${CURRENCY_LABEL[row.currency]}`, row.currency, row.netMinor);
  }
  for (const expense of kpis.expenses) {
    money("المصروفات", expense.name, kpis.baseCurrency, expense.amountMinor);
  }
  money("المصروفات", "إجمالي المصروفات (بالأساس)", kpis.baseCurrency, kpis.totalExpensesMinor);
  // (المراجعة النهائية للمال ١) الصندوق محاسبةٌ بالأساس: كل صف بالعملة
  // الأساسية مع هوية الدرج في البند — لا يُعرض مبلغ درجٍ سعودي/دولاري بعملته
  // الأصلية أبدًا (195,000 ر.ي لا 1,950.00 ر.س).
  for (const row of kpis.cashMovements) {
    money("الصندوق", `صندوق ${CURRENCY_LABEL[row.cashAccountCurrency]} — تحصيل (مكافئ أساس)`, kpis.baseCurrency, row.collectedBaseMinor);
    money("الصندوق", `صندوق ${CURRENCY_LABEL[row.cashAccountCurrency]} — صرف (مكافئ أساس)`, kpis.baseCurrency, row.paidOutBaseMinor);
    money("الصندوق", `صندوق ${CURRENCY_LABEL[row.cashAccountCurrency]} — صافي (مكافئ أساس)`, kpis.baseCurrency, row.netBaseMinor);
  }
  // (تصحيح ١) الذمم لكل عملة — من مرجع أرصدة المرضى القانوني.
  for (const row of kpis.receivableByCurrency) {
    money("الذمم", `ذمم المرضى (تراكمي) — ${CURRENCY_LABEL[row.currency]}`, row.currency, row.dueMinor);
  }
  money("الذمم", "ذمم المعامل والموردين (تراكمي)", kpis.baseCurrency, kpis.payableMinor);
  for (const party of kpis.parties) {
    money("الذمم — تفصيل", party.label, kpis.baseCurrency, party.dueMinor);
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

import type { Currency } from "./money";

/**
 * المحاسبة بالقيد المزدوج — المنطق الخالص.
 *
 * هذا ما يفصل «شاشات مالية» عن **نظام محاسبي**: كل حركة مال تُقيَّد في طرفين، مدين
 * ودائن، بمبلغ واحد. والفائدة ليست شكلية — هي أن الخطأ **يُكتشف**: ميزان المراجعة لا
 * يتوازن إن ضاع طرف، بينما جدول مدفوعات بلا قيد مزدوج يبتلع الخطأ بصمت إلى الأبد.
 *
 * **قرار بنيوي: القيود تُشتقّ من المستندات لا تُخزَّن معها.**
 *
 * الطريقة الشائعة أن يُكتب القيد في جدول عند إنشاء كل مستند. وعيبها أن مصدرين
 * للحقيقة: فاتورة في جدول وقيدها في آخر، وأي خلل في الكتابة المزدوجة — انقطاع،
 * استثناء، تعديل لاحق — يجعل الدفاتر تخالف المستندات ولا أحد يعرف أيّهما الصحيح.
 * وإصلاحها يحتاج محاسبًا لا مبرمجًا.
 *
 * هنا القيد **دالة** من المستند: الفاتورة تُنتج قيدها كلما قُرئت. فلا تعارض ممكن،
 * ولا ترحيل خلفي للبيانات القائمة، ولا قيد يتيم. وما لا يُشتقّ من مستند — قيود
 * التسوية والإهلاك وإعادة تقييم العملات — يُكتب يدويًا في جدول القيود ويُدمج معها.
 */

export type AccountKind = "asset" | "liability" | "equity" | "revenue" | "expense";

export interface Account {
  code: string;
  name: string;
  kind: AccountKind;
  /** الحساب الأب في الدليل — للتجميع في القوائم. */
  parent: string | null;
}

/**
 * دليل الحسابات.
 *
 * مرقّم بالنظام المتعارف عليه عالميًا: 1 أصول، 2 خصوم، 3 حقوق ملكية، 4 إيرادات،
 * 5 مصروفات. الترقيم ليس تجميلًا — أي محاسب يفتح البرنامج يعرف مكانه فورًا، وأي
 * تصدير إلى برنامج محاسبي آخر يُقابَل بلا إعادة تسمية.
 *
 * وهو مختصر عمدًا: دليل من مئة حساب في عيادة بكرسيين يُملأ نصفه بأصفار، ويجعل كل
 * قيد سؤالًا عن الحساب الصحيح.
 */
export const ACCOUNTS: Account[] = [
  { code: "1", name: "الأصول", kind: "asset", parent: null },
  { code: "11", name: "النقدية", kind: "asset", parent: "1" },
  { code: "1101", name: "الصندوق — ريال يمني", kind: "asset", parent: "11" },
  { code: "1102", name: "الصندوق — ريال سعودي", kind: "asset", parent: "11" },
  { code: "1103", name: "الصندوق — دولار", kind: "asset", parent: "11" },
  { code: "12", name: "الذمم المدينة", kind: "asset", parent: "1" },
  { code: "1201", name: "ذمم المرضى", kind: "asset", parent: "12" },

  { code: "2", name: "الخصوم", kind: "liability", parent: null },
  { code: "21", name: "الذمم الدائنة", kind: "liability", parent: "2" },
  { code: "2101", name: "ذمم المعامل والموردين", kind: "liability", parent: "21" },

  { code: "3", name: "حقوق الملكية", kind: "equity", parent: null },
  { code: "3101", name: "رأس المال والأرصدة الافتتاحية", kind: "equity", parent: "3" },

  { code: "4", name: "الإيرادات", kind: "revenue", parent: null },
  { code: "4101", name: "إيرادات الخدمات", kind: "revenue", parent: "4" },
  { code: "4201", name: "الخصومات الممنوحة", kind: "revenue", parent: "4" },

  { code: "5", name: "المصروفات", kind: "expense", parent: null },
  { code: "5101", name: "تكلفة المعامل", kind: "expense", parent: "5" },
  { code: "5201", name: "مواد ومستهلكات", kind: "expense", parent: "5" },
  { code: "5301", name: "عمولات الأطباء", kind: "expense", parent: "5" },
  { code: "5401", name: "الرواتب", kind: "expense", parent: "5" },
  { code: "5501", name: "الإيجار والخدمات", kind: "expense", parent: "5" },
  { code: "5901", name: "مصروفات أخرى", kind: "expense", parent: "5" },
  { code: "5951", name: "فروقات أسعار الصرف", kind: "expense", parent: "5" },
  { code: "5961", name: "عجز وزيادة الصندوق", kind: "expense", parent: "5" },
];

export const ACCOUNT_BY_CODE = new Map(ACCOUNTS.map((account) => [account.code, account]));

/** الحسابات التي تُقيَّد فيها الحركات — لا الحسابات التجميعية. */
export const POSTABLE_ACCOUNTS = ACCOUNTS.filter((account) => account.code.length >= 4);

export const CASH_ACCOUNT: Record<Currency, string> = {
  YER: "1101", SAR: "1102", USD: "1103",
};

export const AR_ACCOUNT = "1201";
export const AP_ACCOUNT = "2101";
export const REVENUE_ACCOUNT = "4101";
export const DISCOUNT_ACCOUNT = "4201";
export const CASH_DIFF_ACCOUNT = "5961";
export const OPENING_EQUITY_ACCOUNT = "3101";
export const FX_ACCOUNT = "5951";

/** حساب المصروف لكل تصنيف — القائمة الوحيدة التي تربط التشغيل بالمحاسبة. */
export const EXPENSE_ACCOUNT: Record<string, string> = {
  lab: "5101",
  materials: "5201",
  commission: "5301",
  salary: "5401",
  rent: "5501",
  supplier: "5201",
  other: "5901",
};

export interface JournalLine {
  accountCode: string;
  /** موجب دائمًا؛ الجهة تحدّدها `side`. */
  amountMinor: number;
  side: "debit" | "credit";
}

export interface JournalEntry {
  /** مصدر القيد: نوع المستند ورقمه — فكل سطر في الدفاتر يعود إلى ورقة. */
  source: string;
  reference: string;
  date: string;
  description: string;
  lines: JournalLine[];
}

/** مجموع طرف من القيد. */
export function sideTotal(entry: JournalEntry, side: "debit" | "credit"): number {
  return entry.lines
    .filter((line) => line.side === side)
    .reduce((total, line) => total + line.amountMinor, 0);
}

/**
 * هل يتوازن القيد؟
 *
 * الفحص الذي يجعل النظام محاسبيًا: قيدٌ لا يتوازن **يُرفض** بدل أن يدخل الدفاتر
 * ويُكتشف بعد شهور في ميزان مراجعة لا يقفل، حين يكون تتبّعه مستحيلًا.
 */
export function isBalanced(entry: JournalEntry): boolean {
  return sideTotal(entry, "debit") === sideTotal(entry, "credit");
}

// ── قواعد الترحيل ───────────────────────────────────────────────────────────

/**
 * قيد الفاتورة.
 *
 * مدين ذمم المرضى بالصافي، ومدين الخصومات الممنوحة بالخصم، ودائن الإيراد بالإجمالي.
 * الخصم يُقيَّد **مصروفًا مقابلًا للإيراد** لا يُخصم من الإيراد مباشرة: صاحب العيادة
 * الذي لا يرى كم خصم لا يعرف أنه يهدي ربع دخله.
 */
export function invoiceEntry(input: {
  invoiceNumber: string;
  date: string;
  patientName: string;
  totalMinor: number;
  discountMinor: number;
  cancelled: boolean;
}): JournalEntry | null {
  if (input.cancelled || input.totalMinor <= 0) return null;
  const discount = Math.min(Math.max(0, input.discountMinor), input.totalMinor);
  const net = input.totalMinor - discount;
  const lines: JournalLine[] = [
    { accountCode: AR_ACCOUNT, amountMinor: net, side: "debit" },
    { accountCode: REVENUE_ACCOUNT, amountMinor: input.totalMinor, side: "credit" },
  ];
  if (discount > 0) {
    lines.push({ accountCode: DISCOUNT_ACCOUNT, amountMinor: discount, side: "debit" });
  }
  return {
    source: "invoice",
    reference: input.invoiceNumber,
    date: input.date,
    description: `فاتورة ${input.patientName}`,
    lines,
  };
}

/**
 * قيد الدفعة.
 *
 * مدين صندوق العملة المقبوضة، دائن ذمم المرضى — بالمكافئ الأساسي، لأن الدفاتر كلها
 * بعملة واحدة. والاسترداد يعكس الطرفين ولا يُحذف قيد: **الدفاتر لا تُمحى، تُعكَس**،
 * وهذا فرق جوهري بين نظام يُدقَّق ونظام يُصدَّق على كلام صاحبه.
 */
export function paymentEntry(input: {
  receiptNumber: string;
  date: string;
  patientName: string;
  currency: Currency;
  baseAmountMinor: number;
  kind: "payment" | "refund";
}): JournalEntry | null {
  if (input.baseAmountMinor <= 0) return null;
  const cash = CASH_ACCOUNT[input.currency];
  const isRefund = input.kind === "refund";
  return {
    source: isRefund ? "refund" : "payment",
    reference: input.receiptNumber,
    date: input.date,
    description: `${isRefund ? "استرداد إلى" : "قبض من"} ${input.patientName}`,
    lines: [
      { accountCode: isRefund ? AR_ACCOUNT : cash, amountMinor: input.baseAmountMinor, side: "debit" },
      { accountCode: isRefund ? cash : AR_ACCOUNT, amountMinor: input.baseAmountMinor, side: "credit" },
    ],
  };
}

/**
 * قيد الرصيد الافتتاحي لمريض.
 *
 * مدين ذمم المرضى، دائن رأس المال والأرصدة الافتتاحية.
 *
 * **الطرف الدائن حقوق ملكية لا إيراد** — وهذا هو بيت القصيد. الطريقة السهلة أن
 * يُفتح للمريض «فاتورة سابقة» بقيمة ما عليه، فيدخل دَينٌ عمره سنتان في إيراد هذا
 * الشهر: تظهر العيادة رابحة بملايين لم تكسبها في هذه الفترة، وتُحسب عليها عمولات
 * أطباء عن عمل قديم دُفعت عمولته أصلًا، وتُبنى قرارات على ربح وهمي.
 *
 * الصحيح محاسبيًا أن الدَّين السابق **أصلٌ افتتاحي** جاء مع افتتاح الدفاتر لا كسبٌ
 * تحقّق فيها. فيظهر في الميزانية ضمن ذمم المرضى، ولا يمسّ قائمة الدخل بشيء.
 */
export function openingBalanceEntry(input: {
  patientId: number;
  date: string;
  patientName: string;
  amountMinor: number;
}): JournalEntry | null {
  if (input.amountMinor <= 0) return null;
  return {
    source: "opening",
    reference: `OB-${input.patientId}`,
    date: input.date,
    description: `رصيد افتتاحي — ${input.patientName}`,
    lines: [
      { accountCode: AR_ACCOUNT, amountMinor: input.amountMinor, side: "debit" },
      { accountCode: OPENING_EQUITY_ACCOUNT, amountMinor: input.amountMinor, side: "credit" },
    ],
  };
}

/**
 * قيد الالتزام (فاتورة مورّد أو تكلفة عمل مختبر).
 *
 * مدين حساب المصروف، دائن ذمم المعامل والموردين. هذا هو **أساس الاستحقاق**: المصروف
 * يُثبَت يوم نشأ لا يوم دُفع، فتظهر تكلفة الشهر في شهرها حتى لو سُدّدت بعد ثلاثة.
 * بلا ذلك تبدو أشهر بلا تكاليف وأشهر مثقلة بها، ولا يُعرف ربح شهر واحد.
 */
export function payableEntry(input: {
  reference: string;
  date: string;
  partyName: string;
  category: string;
  baseAmountMinor: number;
}): JournalEntry | null {
  if (input.baseAmountMinor <= 0) return null;
  return {
    source: "payable",
    reference: input.reference,
    date: input.date,
    description: `التزام لـ${input.partyName}`,
    lines: [
      {
        accountCode: EXPENSE_ACCOUNT[input.category] ?? EXPENSE_ACCOUNT.other,
        amountMinor: input.baseAmountMinor,
        side: "debit",
      },
      { accountCode: AP_ACCOUNT, amountMinor: input.baseAmountMinor, side: "credit" },
    ],
  };
}

/**
 * قيد الصرف.
 *
 * صرفٌ **لجهة مسجّلة** يُسدّد التزامًا: مدين ذمم الموردين، دائن الصندوق. وصرفٌ بلا
 * جهة مصروفٌ مباشر: مدين حساب المصروف، دائن الصندوق.
 *
 * التمييز ضروري: لو قُيّد سداد المختبر مصروفًا لظهرت التكلفة مرتين — مرة يوم نشأ
 * الالتزام ومرة يوم سُدّد — فيبدو الشهر خاسرًا وهو ليس كذلك.
 */
export function expenseEntry(input: {
  voucherNumber: string;
  date: string;
  payeeName: string;
  category: string;
  currency: Currency;
  baseAmountMinor: number;
  settlesPayable: boolean;
}): JournalEntry | null {
  if (input.baseAmountMinor <= 0) return null;
  return {
    source: "expense",
    reference: input.voucherNumber,
    date: input.date,
    description: `صرف إلى ${input.payeeName}`,
    lines: [
      {
        accountCode: input.settlesPayable
          ? AP_ACCOUNT
          : EXPENSE_ACCOUNT[input.category] ?? EXPENSE_ACCOUNT.other,
        amountMinor: input.baseAmountMinor,
        side: "debit",
      },
      { accountCode: CASH_ACCOUNT[input.currency], amountMinor: input.baseAmountMinor, side: "credit" },
    ],
  };
}

/**
 * قيد فرق الجرد عند إغلاق الوردية.
 *
 * النقص يُقيَّد مصروفًا والزيادة تُقيَّد إيرادًا سالبًا في نفس الحساب. وإثباته في
 * الدفاتر — لا تركه ملاحظةً في الوردية — هو ما يجعل رصيد الصندوق في الميزانية
 * مطابقًا لما في الدرج فعلًا.
 */
export function cashDifferenceEntry(input: {
  shiftId: number;
  date: string;
  currency: Currency;
  differenceMinor: number;
}): JournalEntry | null {
  if (input.differenceMinor === 0) return null;
  const amount = Math.abs(input.differenceMinor);
  const shortage = input.differenceMinor < 0;
  return {
    source: "cash_diff",
    reference: `SH-${input.shiftId}-${input.currency}`,
    date: input.date,
    description: shortage ? "عجز في جرد الصندوق" : "زيادة في جرد الصندوق",
    lines: [
      {
        accountCode: shortage ? CASH_DIFF_ACCOUNT : CASH_ACCOUNT[input.currency],
        amountMinor: amount,
        side: "debit",
      },
      {
        accountCode: shortage ? CASH_ACCOUNT[input.currency] : CASH_DIFF_ACCOUNT,
        amountMinor: amount,
        side: "credit",
      },
    ],
  };
}

/**
 * قيد إعادة تقييم النقد الأجنبي.
 *
 * ارتفع سعر العملة: مدين صندوقها، دائن فروقات الصرف — ربحٌ حقيقي وإن لم يدخل ريال
 * جديد إلى الدرج. وانخفض: العكس.
 *
 * والفرق يدخل **قائمة الدخل** لا حقوق الملكية، وهذا هو المتعارف عليه عالميًا للبنود
 * النقدية (IAS 21): من احتفظ بدولارات فربح من ارتفاعها فقد ربح من قرارٍ اتخذه، لا
 * من رأس مال أضافه.
 *
 * ويُقيَّد في حساب مستقل لا يُخلط بعجز الجرد: الجرد يعالج الفرق بين الدرج والدفاتر،
 * وإعادة التقييم تعالج تغيّر السعر — وخلطهما يجعل الحسابين بلا معنى، فلا يُعرف أضاع
 * الصندوق مالًا أم تحرّك السعر.
 */
export function revaluationEntry(input: {
  date: string;
  currency: Currency;
  differenceMinor: number;
}): JournalEntry | null {
  if (input.differenceMinor === 0) return null;
  const amount = Math.abs(input.differenceMinor);
  const gain = input.differenceMinor > 0;
  const cash = CASH_ACCOUNT[input.currency];
  return {
    source: "fx",
    reference: `FX-${input.date}-${input.currency}`,
    date: input.date,
    description: gain
      ? `فرق إعادة تقييم ${input.currency} — ربح`
      : `فرق إعادة تقييم ${input.currency} — خسارة`,
    lines: [
      { accountCode: gain ? cash : FX_ACCOUNT, amountMinor: amount, side: "debit" },
      { accountCode: gain ? FX_ACCOUNT : cash, amountMinor: amount, side: "credit" },
    ],
  };
}

// ── القوائم ─────────────────────────────────────────────────────────────────

export interface AccountBalance {
  code: string;
  name: string;
  kind: AccountKind;
  debitMinor: number;
  creditMinor: number;
  /** الرصيد بإشارة طبيعة الحساب: موجب = الطبيعة، سالب = عكسها. */
  balanceMinor: number;
}

/** طبيعة الحساب: أصول ومصروفات مدينة، وخصوم وحقوق ملكية وإيرادات دائنة. */
export function naturalSide(kind: AccountKind): "debit" | "credit" {
  return kind === "asset" || kind === "expense" ? "debit" : "credit";
}

export function trialBalance(entries: JournalEntry[]): AccountBalance[] {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const current = totals.get(line.accountCode) ?? { debit: 0, credit: 0 };
      if (line.side === "debit") current.debit += line.amountMinor;
      else current.credit += line.amountMinor;
      totals.set(line.accountCode, current);
    }
  }

  return POSTABLE_ACCOUNTS
    .filter((account) => totals.has(account.code))
    .map((account) => {
      const value = totals.get(account.code)!;
      const natural = naturalSide(account.kind);
      return {
        code: account.code,
        name: account.name,
        kind: account.kind,
        debitMinor: value.debit,
        creditMinor: value.credit,
        balanceMinor: natural === "debit" ? value.debit - value.credit : value.credit - value.debit,
      };
    });
}

export interface IncomeStatement {
  revenueMinor: number;
  discountMinor: number;
  netRevenueMinor: number;
  expenses: { code: string; name: string; amountMinor: number }[];
  totalExpensesMinor: number;
  netProfitMinor: number;
}

/**
 * قائمة الدخل — على **أساس الاستحقاق**.
 *
 * الإيراد من الفواتير لا من التحصيل، والمصروف من الالتزامات لا من السداد. وهذا هو
 * المعيار المحاسبي، والفرق عملي لا نظري: عيادة فوترت مليونًا وحصّلت نصفه ربحت
 * بمقدار ما عملت لا بمقدار ما قبضت — والباقي دَينٌ في الميزانية لا خسارة.
 */
export function incomeStatement(balances: AccountBalance[]): IncomeStatement {
  const find = (code: string) => balances.find((row) => row.code === code)?.balanceMinor ?? 0;
  const revenueMinor = find(REVENUE_ACCOUNT);
  // الخصومات حسابٌ مدين داخل مجموعة الإيرادات، فرصيده الطبيعي دائن ويظهر سالبًا.
  const discountMinor = Math.abs(find(DISCOUNT_ACCOUNT));

  const expenses = balances
    .filter((row) => row.kind === "expense" && row.balanceMinor !== 0)
    .map((row) => ({ code: row.code, name: row.name, amountMinor: row.balanceMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
  const totalExpensesMinor = expenses.reduce((sum, row) => sum + row.amountMinor, 0);
  const netRevenueMinor = revenueMinor - discountMinor;

  return {
    revenueMinor,
    discountMinor,
    netRevenueMinor,
    expenses,
    totalExpensesMinor,
    netProfitMinor: netRevenueMinor - totalExpensesMinor,
  };
}

export interface BalanceSheet {
  assets: { code: string; name: string; amountMinor: number }[];
  liabilities: { code: string; name: string; amountMinor: number }[];
  equity: { code: string; name: string; amountMinor: number }[];
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  capitalMinor: number;
  retainedEarningsMinor: number;
  equityMinor: number;
  /** الفرق بين الأصول وما يقابلها — يجب أن يكون صفرًا. */
  differenceMinor: number;
}

/**
 * الميزانية العمومية.
 *
 * الأصول = الخصوم + حقوق الملكية. وحقوق الملكية طرفان: **رأس المال والأرصدة
 * الافتتاحية** من حسابات المجموعة 3، و**أرباح الفترة** من قائمة الدخل.
 *
 * قراءة حسابات المجموعة 3 من الميزان نفسه لا من وسيطٍ يُمرَّر: كان الرصيد الافتتاحي
 * يُقيَّد في الدفاتر ولا يظهر في الميزانية، فتبدو غير متوازنة بمقدار رأس المال
 * بالضبط — وهو أسوأ نوع خطأ: رقمٌ يبدو خللًا في النظام وهو خللٌ في قراءته.
 */
export function balanceSheet(balances: AccountBalance[]): BalanceSheet {
  const pick = (kind: AccountKind) => balances
    .filter((row) => row.kind === kind && row.balanceMinor !== 0)
    .map((row) => ({ code: row.code, name: row.name, amountMinor: row.balanceMinor }));

  const assets = pick("asset");
  const liabilities = pick("liability");
  const equity = pick("equity");

  const totalAssetsMinor = assets.reduce((sum, row) => sum + row.amountMinor, 0);
  const totalLiabilitiesMinor = liabilities.reduce((sum, row) => sum + row.amountMinor, 0);
  const capitalMinor = equity.reduce((sum, row) => sum + row.amountMinor, 0);
  const retainedEarningsMinor = incomeStatement(balances).netProfitMinor;
  const equityMinor = capitalMinor + retainedEarningsMinor;

  return {
    assets,
    liabilities,
    equity,
    totalAssetsMinor,
    totalLiabilitiesMinor,
    capitalMinor,
    retainedEarningsMinor,
    equityMinor,
    differenceMinor: totalAssetsMinor - (totalLiabilitiesMinor + equityMinor),
  };
}

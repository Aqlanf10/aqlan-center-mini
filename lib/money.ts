/**
 * المال — المنطق الخالص.
 *
 * هذا أخطر ملف في البرنامج. خطأ في اللوحة يُصحَّح بإعادة تحميل الصفحة؛ وخطأ هنا
 * يظهر بعد شهر في رصيد مريض يجادل عليه، أو في صندوق ينقص ولا أحد يعرف لماذا.
 *
 * ثلاث قواعد تحكم كل سطر:
 *
 * ١) **المبالغ تُخزَّن أعدادًا صحيحة**، لا كسورًا عشرية. `0.1 + 0.2` في جافاسكربت
 *    ليست `0.3`، وجمع مئة دفعة بهذا الحساب يعطي رصيدًا يخالف الورقة بريالات. الريال
 *    اليمني بلا كسور عمليًا، والسعودي والدولار يُخزَّنان بالهللة والسنت.
 *
 * ٢) **كل دفعة تحمل سعر صرفها لحظة الدفع**. سعر الصرف في اليمن يتغيّر أسبوعيًا
 *    وأحيانًا يوميًا. لو حُسبت الدفعات القديمة بسعر اليوم لتغيّر رصيد كل مريض كلما
 *    حُدِّث السعر — وهو ما يجعل السجل بلا معنى. السعر يُنسخ في صفّ الدفعة ولا يُقرأ
 *    من الإعدادات بعدها أبدًا.
 *
 * ٣) **الفاتورة بالعملة الأساسية، والتحصيل بأي عملة**. المريض يدفع دولارًا اليوم
 *    وريالًا الأسبوع القادم، والرصيد يبقى رقمًا واحدًا مفهومًا.
 */

export type Currency = "YER" | "SAR" | "USD";

/** عملة القاعدة المحاسبية للمركز — كل الموازنات والانحرافات تُقاس بها. */
export const CLINIC_BASE_CURRENCY: Currency = "YER";

export const CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

export const CURRENCY_LABEL: Record<Currency, string> = {
  YER: "ريال يمني",
  SAR: "ريال سعودي",
  USD: "دولار",
};

export const CURRENCY_SHORT: Record<Currency, string> = {
  YER: "ر.ي",
  SAR: "ر.س",
  USD: "$",
};

/**
 * الوحدات الصغرى في الوحدة الكبرى لكل عملة.
 *
 * الريال اليمني بلا فئات صغرى متداولة — الفلس اختفى عمليًا — فيُخزَّن بوحدته. أما
 * السعودي والدولار فبمئة، لأن «12.50 دولارًا» رقم يُكتب فعلًا في العيادة.
 */
export const MINOR_UNITS: Record<Currency, number> = { YER: 1, SAR: 100, USD: 100 };

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as string[]).includes(value);
}

/**
 * يحوّل ما كتبه الإنسان إلى عدد صحيح من الوحدات الصغرى.
 *
 * يقبل الأرقام العربية الهندية والفواصل العشرية والآلاف («12,500» و«١٢٥٠٠»)، لأن هذا
 * ما تكتبه الاستقبال فعلًا. ويعيد `null` لما لا يُقرأ رقمًا — ورفضُ الإدخال أفضل من
 * تخزين صفر بصمت.
 */
export function parseAmount(input: string, currency: Currency): number | null {
  const western = String(input)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[٫،]/g, ".")
    .replace(/[,\s_]/g, "")
    .trim();
  if (!western || !/^\d*\.?\d*$/.test(western) || western === ".") return null;
  const value = Number(western);
  if (!Number.isFinite(value) || value < 0) return null;
  const minor = Math.round(value * MINOR_UNITS[currency]);
  return Number.isSafeInteger(minor) ? minor : null;
}

/** يعيد العدد الصحيح إلى صورته المقروءة. */
export function formatAmount(minor: number, currency: Currency): string {
  const units = MINOR_UNITS[currency];
  const value = minor / units;
  const fixed = units === 1 ? Math.round(value).toString() : value.toFixed(2);
  const [whole, fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * عكسُ `parseAmount` لنماذج الإدخال: يعيد المبلغ المخزَّن بالوحدات الصغرى نصًّا
 * بالوحدات الكبرى صالحًا لملء خانةٍ تُقرأ لاحقًا بـ `parseAmount` نفسها.
 *
 * عشرون دولارًا تُخزَّن ٢٠٠٠ سنت وتعود «20» — لا «2000». الملء المباشر بالقيمة
 * الصغرى كان يضاعف المبلغ مئة ضعف عند كل حفظ، فصار السعر المجلوب ألفين دولار.
 * الحساب صحيحٌ بالأعداد الصحيحة فلا كسور عائمة تفسد الدورة ذهابًا وإيابًا.
 */
export function toInputAmount(minor: number, currency: Currency): string {
  const units = MINOR_UNITS[currency];
  if (units === 1) return String(minor);
  const whole = Math.trunc(minor / units);
  const cents = minor % units;
  if (cents === 0) return String(whole);
  const padded = String(cents).padStart(String(units).length - 1, "0").replace(/0+$/, "");
  return `${whole}.${padded}`;
}

export function formatMoney(minor: number, currency: Currency): string {
  return `${formatAmount(minor, currency)} ${CURRENCY_SHORT[currency]}`;
}

/**
 * يحوّل مبلغًا بعملة إلى ما يعادله بالعملة الأساسية.
 *
 * `rate` هو كم وحدةً أساسية تساوي **وحدةً واحدة كبرى** من العملة المدفوعة (مثلًا
 * 530 ريالًا يمنيًا للدولار). القسمة على الوحدات الصغرى تجري قبل الضرب لا بعده حتى
 * لا يُضرب السنت في السعر فيصير المبلغ مئة ضعف.
 */
export function toBaseAmount(
  minor: number,
  currency: Currency,
  base: Currency,
  rate: number,
): number {
  if (currency === base) return minor;
  const major = minor / MINOR_UNITS[currency];
  return Math.round(major * rate * MINOR_UNITS[base]);
}

export interface PaymentLike {
  amountMinor: number;
  currency: Currency;
  exchangeRate: number;
  baseAmountMinor: number;
  /** الاسترداد يُسجَّل دفعةً سالبة الأثر، لا يُحذف: المحذوف لا يُراجَع. */
  kind: "payment" | "refund";
}

export interface InvoiceLike {
  totalMinor: number;
  discountMinor: number;
  status: "open" | "paid" | "cancelled";
}

/** صافي الفاتورة بعد الخصم — ولا يقلّ عن صفر مهما بلغ الخصم. */
export function invoiceNet(invoice: InvoiceLike): number {
  if (invoice.status === "cancelled") return 0;
  return Math.max(0, invoice.totalMinor - invoice.discountMinor);
}

/** ما حُصّل فعلًا بالعملة الأساسية: الدفعات ناقص الاستردادات. */
export function collectedBase(payments: PaymentLike[]): number {
  return payments.reduce(
    (total, payment) =>
      total + (payment.kind === "refund" ? -payment.baseAmountMinor : payment.baseAmountMinor),
    0,
  );
}

export interface Balance {
  billedMinor: number;
  collectedMinor: number;
  /** ما كان على المريض قبل بدء النظام — دَينٌ حقيقي لا فاتورة في هذا النظام. */
  openingMinor: number;
  /** موجب = على المريض، سالب = له عندنا. */
  dueMinor: number;
}

/**
 * رصيد المريض.
 *
 * الرقم الذي يُسأل عنه على الباب. سالبًا يعني أن للمريض رصيدًا عندنا — وهي حالة
 * حقيقية تحدث عند الاسترداد أو الدفع المقدّم، وإخفاؤها بجعل الأدنى صفرًا يعني أن
 * تضيع أموال المرضى بصمت.
 *
 * والرصيد الافتتاحي يدخل الحساب كما تدخله الفاتورة: من كان عليه مئة ألف قبل تشغيل
 * النظام لا يصير حسابه صفرًا لأن النظام جديد. لكنه يبقى **بندًا مستقلًا** لا يُخلط
 * بالمفوتر، لأنه ليس إيراد هذه الفترة ولا يستحق عليه عمولة.
 */
export function patientBalance(
  invoices: InvoiceLike[],
  payments: PaymentLike[],
  openingMinor = 0,
): Balance {
  const billedMinor = invoices.reduce((total, invoice) => total + invoiceNet(invoice), 0);
  const collectedMinor = collectedBase(payments);
  return {
    billedMinor,
    collectedMinor,
    openingMinor,
    dueMinor: openingMinor + billedMinor - collectedMinor,
  };
}

/** «على المريض 12,500 ر.ي» / «للمريض 3,000 ر.ي» / «الحساب مسدّد». */
export function balanceText(balance: Balance, base: Currency): string {
  if (balance.dueMinor === 0) return "الحساب مسدّد";
  return balance.dueMinor > 0
    ? `على المريض ${formatMoney(balance.dueMinor, base)}`
    : `للمريض ${formatMoney(-balance.dueMinor, base)}`;
}

export interface ShiftTotals {
  /** ما دخل الصندوق بكل عملة على حدة — لأن الجرد يُعدّ بالورق لا بالمكافئ. */
  byCurrency: Record<Currency, number>;
  baseTotalMinor: number;
  paymentCount: number;
}

/**
 * إجماليات الوردية.
 *
 * الإجمالي بالعملة الأساسية يقول كم دخل، لكن الجرد يُعدّ **بالورق**: من يعدّ الصندوق
 * آخر اليوم يعدّ دولارات ودولارات وريالات كلًّا على حدة. فمقارنة الجرد بالمكافئ
 * الأساسي وحده تجعل كل إغلاق يبدو ناقصًا أو زائدًا بلا سبب.
 */
export function shiftTotals(payments: PaymentLike[]): ShiftTotals {
  const byCurrency: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
  let baseTotalMinor = 0;
  for (const payment of payments) {
    const sign = payment.kind === "refund" ? -1 : 1;
    byCurrency[payment.currency] += sign * payment.amountMinor;
    baseTotalMinor += sign * payment.baseAmountMinor;
  }
  return { byCurrency, baseTotalMinor, paymentCount: payments.length };
}

/** فرق الجرد: المعدود ناقص المتوقَّع، لكل عملة. سالب = نقص. */
export function countDifference(
  expected: Record<Currency, number>,
  counted: Record<Currency, number>,
): Record<Currency, number> {
  return {
    YER: counted.YER - expected.YER,
    SAR: counted.SAR - expected.SAR,
    USD: counted.USD - expected.USD,
  };
}

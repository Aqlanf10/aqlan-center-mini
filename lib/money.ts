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
 * (P-01 owner review — تصحيح ٣) عملةٌ مالية مجهولة = فسادُ بياناتٍ لا افتراضُ أساس.
 *
 * القاعدة القديمة كانت: عملةٌ لا تُعرَف؟ فلتُعامل كأنها يمني. وذلك إعادةُ وسمٍ
 * صامتة: صفٌّ فاسد العملة (أو تاريخيٌّ غريب) يدخل الميزان يمنيًّا فيُخلط المال
 * ويحسب رصيدًا خاطئًا بصمت — والعيبُ لا يُكتشف إلا في أرشيف.
 *
 * القاعدة الجديدة (fail-closed): أي عملة مجهولة تشارك في الأرصدة أو التقارير
 * تُرفض فورًا برسالة سلامةٍ مالية صريحة تحمل الجهة والمعرّف والقيمة الفاسدة.
 * استبدالُ العملة أو تخطي الصف ليس خيارًا: الفساد يُقال لا يُدار.
 */
export class FinancialCurrencyIntegrityError extends Error {
  readonly entity: string;
  readonly identifier: string;
  readonly currency: string;

  constructor(entity: string, identifier: string, currency: string) {
    super(
      `سلامة العملة المالية: ${entity} ${identifier} يحمل عملة غير معروفة «${currency}» — `
        + `العملة لا تُفترض يمنيًّا ولا تُخلط؛ صحّح الصف ثم أعد المحاولة.`,
    );
    this.name = "FinancialCurrencyIntegrityError";
    this.entity = entity;
    this.identifier = identifier;
    this.currency = currency;
  }
}

/**
 * تحقّق عملة صفٍّ مالي قبل دخوله الأرصدة/التقارير — fail-closed.
 *
 * تُستدعى على كل عملةٍ مقروءة من قاعدة البيانات قبل أن تشارك في أي حساب مالي:
 * عملة الفاتورة، عملة الخطة، وعملة الدفعة (الحد الأدنى الذي نصّت عليه مراجعة
 * المالك). ما ليس عملةً معروفة يرفع FinancialCurrencyIntegrityError.
 */
export function requireCurrency(
  value: unknown,
  entity: string,
  identifier: string | number,
): Currency {
  if (!isCurrency(value)) {
    throw new FinancialCurrencyIntegrityError(entity, String(identifier), String(value));
  }
  return value;
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

/* ─── TD-05: رصيد المريض بعملاته المستقلة ────────────────────────────────────
 *
 * المفهومان اللذان لا يُخلطان بعد اليوم (TD-05):
 *
 * أ) العملة الأساسية للمركز — YER ثابتةً دستوريًّا (CLINIC_BASE_CURRENCY):
 *    عملة الدفاتر والموازنات والمكافئات، لا عملة كل حساب مريض.
 *
 * ب) عملة الاتفاق المالي للمريض — YER أو SAR أو USD بحسب اتفاقه:
 *    عملة خطته وفواتيره وأقساطه وكشف حسابه.
 *
 * فالرصيد ليس رقمًا واحدًا أبدًا حين تختلف عملات الاتفاقات: عشرة آلاف ريال يمني
 * وخمسمئة سعودي ومئة دولار أرقامٌ ثلاثة، وجمعها في رقمٍ واحد بلا تحويلٍ مسجَّل
 * تزويرٌ محاسبي بصمت. الرصيد الصحيح **دلوٌ لكل عملة**، والدفعات تُسوّي الدلو
 * الذي خُصَّت له:
 *
 *  - الدفعة المرتبطة بفاتورة تُسوّي دلو عملة تلك الفاتورة (بمبلغها إن كانت بعملتها،
 *    وبمكافئها الأساسي المسجَّل بسعر يومها إن كانت بعملة أخرى عن فاتورةٍ أساسية —
 *    وهو العقد الموثَّق القائم للدفعات العابرة للعملات).
 *  - الدفعة «على الحساب» (بلا فاتورة) المقيَّدة على خطة (TD-05 owner review —
 *    الدفعة المقدَّمة قبل الفوترة) تُسوّي دلو عملة تلك الخطة.
 *  - الدفعة «على الحساب» بلا فاتورةٍ ولا خطة تُسوّي دلو العملة الأساسية — والدفع
 *    الأجنبي هكذا يُرفض عند الإنشاء أصلًا، فلا يصل إلى هنا إلا بالأساس.
 *
 * والدفعات العابرة ضد فاتورةٍ غير أساسية (دولارٌ لفاتورة سعودية مثلًا) تُرفض من
 * الخادم عند الإنشاء؛ وما وُجد منها تاريخيًّا (إن وُجد) يُقيَّد بمكافئه المسجَّل —
 * لا يُسقَط بصمت.
 */

/** فاتورةٌ تعرف عملتها — كل فاتورة بعد TD-05 تحمل عملتها معها. */
export interface CurrencyInvoiceLike extends InvoiceLike {
  baseCurrency: Currency;
}

/** دفعةٌ تعرف هدف تسويتها: عملة فاتورتها، أو عملة خطتها، أو null إذا كانت «على
 * الحساب» بالعملة الأساسية (الهدف الصريح الوحيد الباقي بلا فاتورةٍ ولا خطة). */
export interface CurrencyPaymentLike extends PaymentLike {
  invoiceCurrency: Currency | null;
}

/** أرصدة المريض — دلوٌ مستقل لكل عملة، لا يُجمع بينها أبدًا. */
export function patientBalancesByCurrency(
  invoices: CurrencyInvoiceLike[],
  payments: CurrencyPaymentLike[],
  openingMinor = 0,
): Record<Currency, Balance> {
  const buckets = {} as Record<Currency, Balance>;
  for (const currency of CURRENCIES) {
    buckets[currency] = { billedMinor: 0, collectedMinor: 0, openingMinor: 0, dueMinor: 0 };
  }
  // الرصيد الافتتاحي بلا عملةٍ مخزَّنة — أساسيٌّ بحكم البنية (عمود بلا currency).
  buckets[CLINIC_BASE_CURRENCY].openingMinor = openingMinor;

  for (const invoice of invoices) {
    buckets[invoice.baseCurrency].billedMinor += invoiceNet(invoice);
  }
  for (const payment of payments) {
    const target = payment.invoiceCurrency ?? CLINIC_BASE_CURRENCY;
    // بعملة الدلو نفسها: بمبلغها. بعملة أخرى: بمكافئها المسجَّل بسعر يومها —
    // لا تحويلٌ بسعر اليوم ولا إسقاطٌ بصمت (الإنشاء العابر ضد فاتورةٍ غير أساسية
    // مرفوضٌ من الخادم؛ هذا للتوافق مع أي صفٍّ تاريخي إن وُجد).
    const value = payment.currency === target
      ? payment.amountMinor
      : payment.baseAmountMinor;
    buckets[target].collectedMinor += payment.kind === "refund" ? -value : value;
  }
  for (const currency of CURRENCIES) {
    const bucket = buckets[currency];
    bucket.dueMinor = bucket.openingMinor + bucket.billedMinor - bucket.collectedMinor;
  }
  return buckets;
}

/**
 * الدفعات كما يحتاجها حساب الأرصدة متعدد العملات: كل دفعة مع هدف تسويتها.
 *
 * (TD-05 owner review — Finding 5) هدف التسوية بالأولوية: عملة فاتورتها إن
 * رُبطت بفاتورة، وإلا عملة خطتها إن قُيّدت على خطة (الدفعة المقدَّمة قبل
 * الفوترة)، وإلا فهي «على الحساب» بالعملة الأساسية وحدها — الدفع الأجنبي بلا
 * فاتورةٍ ولا خطة يُرفض عند الإنشاء، فلا يصل إلى هنا هدفٌ أجنبيٌّ غامض.
 */
export function toCurrencyPaymentLikes(
  payments: (PaymentLike & { invoiceId: number | null; planId?: number | null })[],
  invoiceCurrencyById: ReadonlyMap<number, Currency>,
  planCurrencyById?: ReadonlyMap<number, Currency>,
): CurrencyPaymentLike[] {
  return payments.map((payment) => ({
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    exchangeRate: payment.exchangeRate,
    baseAmountMinor: payment.baseAmountMinor,
    kind: payment.kind,
    invoiceCurrency: payment.invoiceId !== null
      ? (invoiceCurrencyById.get(payment.invoiceId) ?? CLINIC_BASE_CURRENCY)
      : payment.planId != null && planCurrencyById
        ? (planCurrencyById.get(payment.planId) ?? CLINIC_BASE_CURRENCY)
        : null,
  }));
}

/**
 * نص أرصدة المريض بكل عملة — سطرٌ لكل عملة ذات نشاط.
 *
 * حين تكون كل الأنشطة بالعملة الأساسية وحدها (الحالة الغالبة) يُعاد سطر واحد
 * كما كان، فلا تتغير شاشةٌ ولا مطبوعة. وحين توجد عملات اتفاق أخرى يظهر كلٌّ منها
 * بسطره الموسوم — لا رقم واحد يمزجها.
 */
export function balancesText(balances: Record<Currency, Balance>): string {
  const active = CURRENCIES.filter((currency) => {
    const bucket = balances[currency];
    return bucket.billedMinor !== 0 || bucket.collectedMinor !== 0
      || bucket.openingMinor !== 0 || bucket.dueMinor !== 0;
  });
  if (active.length === 0) return "الحساب مسدّد";
  if (active.length === 1) return balanceText(balances[active[0]], active[0]);
  return active.map((currency) => {
    const bucket = balances[currency];
    return `${CURRENCY_LABEL[currency]}: ${balanceText(bucket, currency)}`;
  }).join(" · ");
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

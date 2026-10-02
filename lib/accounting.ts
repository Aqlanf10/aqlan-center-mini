import { isCashMethod } from "./shift-close";
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
  /* (P1-3) التحويلات (الكريمي/البنك) تدخل الحساب البنكي لا الدرج — قرار المالك. كانت
     تُقيَّد في الصندوق ثم يُرحَّل غيابها عن الدرج «عجزَ جرد» فتظهر خسارةً وهمية. */
  { code: "1111", name: "البنك والحوالات — ريال يمني", kind: "asset", parent: "11" },
  { code: "1112", name: "البنك والحوالات — ريال سعودي", kind: "asset", parent: "11" },
  { code: "1113", name: "البنك والحوالات — دولار", kind: "asset", parent: "11" },
  { code: "12", name: "الذمم المدينة", kind: "asset", parent: "1" },
  { code: "1201", name: "ذمم المرضى", kind: "asset", parent: "12" },
  /* (TD-REG-028) حساب وسيط: التسوية العابرة للعملات (ريالٌ سعودي يسدّد فاتورة يمنية، أو ريالٌ يمني
     يسدّد التزامًا دولاريًا) تُقيَّد رجلُ كل عملة مقابله — فيتوازن كل دفترٍ بعملته وحده بمبلغين
     مسجَّلين، بلا سعرٍ مخمَّن. رصيده لكل عملة هو «مركز التحويل» — لا يُجمع عبر العملات أبدًا. */
  { code: "19", name: "حسابات وسيطة", kind: "asset", parent: "1" },
  { code: "1901", name: "مقاصة تحويل العملات", kind: "asset", parent: "19" },

  { code: "2", name: "الخصوم", kind: "liability", parent: null },
  { code: "21", name: "الذمم الدائنة", kind: "liability", parent: "2" },
  { code: "2101", name: "ذمم المعامل والموردين — عام", kind: "liability", parent: "21" },
  { code: "2102", name: "ذمم معامل التركيبات والزيركون", kind: "liability", parent: "21" },
  { code: "2103", name: "ذمم معامل التقويم والأجهزة", kind: "liability", parent: "21" },
  { code: "2104", name: "ذمم معامل الزراعة الرقمية", kind: "liability", parent: "21" },
  { code: "2105", name: "مستحقات موردي المواد والمستهلكات", kind: "liability", parent: "21" },
  { code: "2106", name: "مستحقات وعمولات الأطباء المعلقة", kind: "liability", parent: "21" },
  { code: "2107", name: "مستحقات رواتب الكادر والتمريض", kind: "liability", parent: "21" },

  { code: "3", name: "حقوق الملكية", kind: "equity", parent: null },
  { code: "3101", name: "رأس المال والأرصدة الافتتاحية", kind: "equity", parent: "3" },

  { code: "4", name: "الإيرادات", kind: "revenue", parent: null },
  { code: "4101", name: "إيرادات الخدمات", kind: "revenue", parent: "4" },
  { code: "4201", name: "الخصومات الممنوحة", kind: "revenue", parent: "4" },

  { code: "5", name: "المصروفات", kind: "expense", parent: null },
  { code: "5101", name: "تكلفة المعامل — عامة", kind: "expense", parent: "5" },
  { code: "5102", name: "معامل التيجان والجسور والزيركون", kind: "expense", parent: "5" },
  { code: "5103", name: "معامل التقويم والأجهزة الوظيفية", kind: "expense", parent: "5" },
  { code: "5104", name: "معامل الزراعة ودعامات التيتانيوم", kind: "expense", parent: "5" },
  { code: "5105", name: "معامل الأطقم والتراكيب المتحركة", kind: "expense", parent: "5" },
  { code: "5106", name: "معامل الابتسامة الرقمية والفينيرز", kind: "expense", parent: "5" },
  { code: "5107", name: "معامل الليزر والطباعة ثلاثية الأبعاد", kind: "expense", parent: "5" },
  { code: "5109", name: "تكاليف إعادة وتعديل أعمال المعامل", kind: "expense", parent: "5" },
  { code: "5201", name: "مواد ومستهلكات طبية — عامة", kind: "expense", parent: "5" },
  { code: "5202", name: "مواد التخدير والمطهرات الموضعية", kind: "expense", parent: "5" },
  { code: "5203", name: "حشوات ومواد ترميمية ولاصقة", kind: "expense", parent: "5" },
  { code: "5204", name: "مستلزمات الجراحة والخلع والزراعة", kind: "expense", parent: "5" },
  { code: "5205", name: "مستلزمات التعقيم ومكافحة العدوى", kind: "expense", parent: "5" },
  { code: "5206", name: "مستلزمات الوقاية الشخصية والقفازات", kind: "expense", parent: "5" },
  { code: "5207", name: "مواد وأفلام ومستلزمات الأشعة", kind: "expense", parent: "5" },
  { code: "5301", name: "عمولات أطباء الأسنان", kind: "expense", parent: "5" },
  { code: "5401", name: "الرواتب والأجور الشهرية", kind: "expense", parent: "5" },
  { code: "5501", name: "إيجار مبنى العيادة والمقر", kind: "expense", parent: "5" },
  { code: "5502", name: "خدمات الكهرباء والماء ومحروقات المولد", kind: "expense", parent: "5" },
  { code: "5503", name: "خدمات الإنترنت والاتصالات", kind: "expense", parent: "5" },
  { code: "5504", name: "صيانة المقر والسباكة والإنارة", kind: "expense", parent: "5" },
  { code: "5601", name: "صيانة الكراسي والأجهزة الطبية", kind: "expense", parent: "5" },
  { code: "5602", name: "قطع غيار ومعدات العيادة", kind: "expense", parent: "5" },
  { code: "5901", name: "مصروفات إدارية ونظافة وضيافة", kind: "expense", parent: "5" },
  { code: "5902", name: "التسويق والدعاية والإعلانات", kind: "expense", parent: "5" },
  { code: "5951", name: "فروقات أسعار الصرف", kind: "expense", parent: "5" },
  { code: "5961", name: "عجز وزيادة الصندوق", kind: "expense", parent: "5" },
];

export const ACCOUNT_BY_CODE = new Map(ACCOUNTS.map((account) => [account.code, account]));

/** الحسابات التي تُقيَّد فيها الحركات — لا الحسابات التجميعية. */
export const POSTABLE_ACCOUNTS = ACCOUNTS.filter((account) => account.code.length >= 4);

export const CASH_ACCOUNT: Record<Currency, string> = {
  YER: "1101", SAR: "1102", USD: "1103",
};

/** (P1-3) حساب البنك/الحوالات لكل عملة — حيث تُقيَّد سندات التحويل. */
export const BANK_ACCOUNT: Record<Currency, string> = {
  YER: "1111", SAR: "1112", USD: "1113",
};

export const AR_ACCOUNT = "1201";
export const AP_ACCOUNT = "2101";
export const REVENUE_ACCOUNT = "4101";
export const DISCOUNT_ACCOUNT = "4201";
export const CASH_DIFF_ACCOUNT = "5961";
export const OPENING_EQUITY_ACCOUNT = "3101";
export const FX_ACCOUNT = "5951";
/** (TD-REG-028) مقاصة تحويل العملات — رجلا كل تسوية عابرة للعملات تمرّان به، كلٌّ بعملته. */
export const CURRENCY_CLEARING_ACCOUNT = "1901";

/** ترتيب العملات في القوائم — الأساس أولًا. */
export const LEDGER_CURRENCIES: Currency[] = ["YER", "SAR", "USD"];

/** حساب المصروف لكل تصنيف — القائمة التي تربط التشغيل بالمحاسبة.
 * التصنيفات التشغيلية الموسّعة (بنود المصروفات) لكلٍّ منها حسابه القياسي،
 * وما لا مفتاح له هنا يُحلَّل من جدول expense_categories عند الترحيل. */
export const EXPENSE_ACCOUNT: Record<string, string> = {
  electricity: "5502", // خدمات الكهرباء والماء ومحروقات المولد
  maintenance: "5601", // صيانة الكراسي والأجهزة الطبية
  equipment_parts: "5602", // قطع غيار ومعدات العيادة
  internet: "5503", // خدمات الإنترنت والاتصالات
  rent: "5501", // إيجار مبنى العيادة والمقر
  cleaning_hospitality: "5901", // مصروفات إدارية ونظافة وضيافة
  facility_maintenance: "5504", // صيانة وترميم المقر
  marketing: "5902", // تسويق وإعلانات
  lab: "5101",
  materials: "5201",
  commission: "5301",
  salary: "5401",
  supplier: "5201",
  other: "5901",
};

// ── الحسابات القياسية للربط المالي للمختبرات ─────────────────────────────────

export interface StandardAccountItem {
  code: string;
  name: string;
  category: string;
  description: string;
  isDefault?: boolean;
}

export type StandardLabAccount = StandardAccountItem;

/** الحسابات القياسية للمصروفات — تُعرض في إعدادات الربط المالي لكل مختبر. */
export const STANDARD_EXPENSE_ACCOUNTS: StandardAccountItem[] = [
  // تكاليف المعامل
  { code: "5101", name: "تكلفة المعامل — عامة", category: "معامل", description: "الحساب القياسي لتكاليف جميع أنواع الأعمال والمعامل السنية", isDefault: true },
  { code: "5102", name: "معامل التيجان والجسور والزيركون", category: "معامل تركيبات", description: "تكاليف تيجان الزيركون، E.max، PFM، والجسور الثابتة" },
  { code: "5103", name: "معامل التقويم والأجهزة الوظيفية", category: "معامل تقويم", description: "تكاليف قوالب التقويم الشفاف، المثبتات، والأجهزة الوظيفية" },
  { code: "5104", name: "معامل الزراعة ودعامات التيتانيوم", category: "معمل زراعة", description: "تكاليف الدعامات المخصصة والجسور الهجينة وتراكيب الزراعة" },
  { code: "5105", name: "معامل الأطقم والتراكيب المتحركة", category: "معمل متحركة", description: "تكاليف الأطقم الكاملة والجزئية الكروم والنايلون المرن" },
  { code: "5106", name: "معامل الابتسامة الرقمية والفينيرز", category: "معمل تجميل", description: "تكاليف عدسات الفينير الرقمية، اللومينير، والواكس أب DSD" },
  { code: "5107", name: "معامل الليزر والطباعة ثلاثية الأبعاد", category: "معمل رقمية", description: "تكاليف الأدلة الجراحية والنماذج المطبوعة ثلاثية الأبعاد" },
  { code: "5109", name: "تكاليف إعادة وتعديل أعمال المعامل", category: "تعديلات معملية", description: "تكاليف إعادة التصنيع وتعديل اللون أو الإطباق" },

  // المواد والمستلزمات الطبية
  { code: "5201", name: "مواد ومستهلكات طبية — عامة", category: "مواد ومستلزمات", description: "المواد والمستهلكات السنية الأساسية للعيادة", isDefault: true },
  { code: "5202", name: "مواد التخدير والمطهرات الموضعية", category: "مواد ومستلزمات", description: "أمبولات البنج الموضعي، إبر التخدير، والجل المخدر والمطهرات" },
  { code: "5203", name: "حشوات ومواد ترميمية ولاصقة", category: "مواد ومستلزمات", description: "الكومبوزيت، البوندنج، حمض التخريش، ومواد الحشو المؤقت والنهائي" },
  { code: "5204", name: "مستلزمات الجراحة والخلع والزراعة", category: "مواد ومستلزمات", description: "شفرات وخيوط الجراحة، شاش وإسفنج وقف النزيف، ومواد الطعوم" },
  { code: "5205", name: "مستلزمات التعقيم ومكافحة العدوى", category: "تعقيم ووقاية", description: "أكياس الأوتوكلاف، كواشف التعقيم ومحاليل التطهير الطبي" },
  { code: "5206", name: "مستلزمات الوقاية الشخصية والقفازات", category: "تعقيم ووقاية", description: "القفازات الطبية، الكمامات، المرايل والأغطية الواقية" },
  { code: "5207", name: "مواد وأفلام ومستلزمات الأشعة", category: "تشخيص وأشعة", description: "أفلام وحساسات وحوامل الأشعة الرقمية ومحاليل التحميض" },

  // الكادر والتشغيل
  { code: "5301", name: "عمولات أطباء الأسنان", category: "كادر طبي", description: "مستحقات ونسب أطباء الأسنان الأخصائيين والعموم", isDefault: true },
  { code: "5401", name: "الرواتب والأجور الشهرية", category: "كادر إداري وتمريض", description: "الرواتب الشهرية ومستحقات طاقم التمريض والاستقبال والإدارة", isDefault: true },
  { code: "5501", name: "إيجار مبنى العيادة والمقر", category: "مرافق ومباني", description: "الإيجار الشهري أو السنوي لمقر المركز", isDefault: true },
  { code: "5502", name: "خدمات الكهرباء والماء ومحروقات المولد", category: "مرافق وتشغيل", description: "فواتير الكهرباء العمومية، المولد، والمياه" },
  { code: "5503", name: "خدمات الإنترنت والاتصالات", category: "اتصالات", description: "اشتراكات الإنترنت، الخطوط الهاتفية والرسائل" },
  { code: "5504", name: "صيانة المقر والسباكة والإنارة", category: "مرافق وتشغيل", description: "أعمال صيانة مبنى المركز، السباكة، التكييف، وشبكات الإنارة" },
  { code: "5601", name: "صيانة الكراسي والأجهزة الطبية", category: "صيانة وتجهيزات", description: "صيانة دورية وإصلاح كراسي الأسنان، الكمبريسور والتعقيم" },
  { code: "5602", name: "قطع غيار ومعدات العيادة", category: "صيانة وتجهيزات", description: "قطع الغيار والمحركات والقطع الاستهلاكية للأجهزة" },
  { code: "5901", name: "مصروفات إدارية ونظافة وضيافة", category: "إدارية وتشغيلية", description: "المطبوعات، المستلزمات المكتبية، أدوات النظافة والضيافة", isDefault: true },
  { code: "5902", name: "التسويق والدعاية والإعلانات", category: "إدارية وتسويقية", description: "الحملات الإعلانية الرقمية، بطاقات المواعيد، وتصاميم منصات التواصل" },
  { code: "5951", name: "فروقات أسعار الصرف", category: "مالية", description: "أرباح وخسائر فروقات أسعار صرف العملات" },
  { code: "5961", name: "عجز وزيادة الصندوق", category: "تسويات", description: "فروقات جرد الصناديق النقدية" },
];

/** الحسابات القياسية للذمم — تُعرض في إعدادات الربط المالي لكل مختبر. */
export const STANDARD_PAYABLE_ACCOUNTS: StandardAccountItem[] = [
  { code: "2101", name: "ذمم المعامل والموردين — عام", category: "ذمم متداولة", description: "الحساب القياسي لجميع الالتزامات المالية لمعامل الأسنان والموردين", isDefault: true },
  { code: "2102", name: "ذمم معامل التركيبات والزيركون", category: "معامل تركيبات", description: "الالتزامات الخاصة بمعامل التركيبات الثابتة" },
  { code: "2103", name: "ذمم معامل التقويم والأجهزة", category: "معامل تقويم", description: "الالتزامات الخاصة بمعامل التقويم والأجهزة الوظيفية" },
  { code: "2104", name: "ذمم معامل الزراعة الرقمية", category: "معمل زراعة", description: "الالتزامات الخاصة بمعامل زراعة الأسنان والأدلة الجراحية" },
  { code: "2105", name: "مستحقات موردي المواد والمستهلكات", category: "موردو مواد", description: "الالتزامات المالية لموردي وشركات المواد والمستهلكات السنية", isDefault: true },
  { code: "2106", name: "مستحقات وعمولات الأطباء المعلقة", category: "ذمم أطباء", description: "المستحقات المحتجزة أو المعلقة لعمولات الأطباء", isDefault: true },
  { code: "2107", name: "مستحقات رواتب الكادر والتمريض", category: "ذمم موظفين", description: "مستحقات رواتب ومكافآت التمريض والإدارة", isDefault: true },
];

/** حسابات المصروف الخاصة بالمعامل وحدها — لقائمة اختيار الربط المالي. */
export const STANDARD_LAB_EXPENSE_ACCOUNTS: StandardLabAccount[] = STANDARD_EXPENSE_ACCOUNTS.filter(
  (a) => a.code.startsWith("51"),
);

/** حسابات الذمم الخاصة بالمعامل وحدها — لقائمة اختيار الربط المالي. */
export const STANDARD_LAB_PAYABLE_ACCOUNTS: StandardLabAccount[] = STANDARD_PAYABLE_ACCOUNTS.filter(
  (a) => ["2101", "2102", "2103", "2104"].includes(a.code),
);

export interface JournalLine {
  accountCode: string;
  /** (TD-REG-028) عملة السطر — والمبلغ بوحداتها الصغرى هي. لا سطر بلا عملة: وحدةٌ واحدة لكل سطر. */
  currency: Currency;
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

/** مجموع طرف من القيد **بعملة واحدة** — لا مجموع عبر العملات. */
export function sideTotal(entry: JournalEntry, side: "debit" | "credit", currency: Currency): number {
  return entry.lines
    .filter((line) => line.side === side && line.currency === currency)
    .reduce((total, line) => total + line.amountMinor, 0);
}

/** العملات التي يمسّها القيد. */
export function entryCurrencies(entry: JournalEntry): Currency[] {
  return LEDGER_CURRENCIES.filter((currency) => entry.lines.some((line) => line.currency === currency));
}

/**
 * هل يتوازن القيد؟ — **داخل كل عملة على حدة**.
 *
 * الفحص الذي يجعل النظام محاسبيًا: قيدٌ لا يتوازن **يُرفض** بدل أن يدخل الدفاتر ويُكتشف بعد
 * شهور. و(TD-REG-028) التوازن لكل عملة لا للقيد كله: «مدين صندوق 100 ر.س / دائن إيراد 100 ر.ي»
 * متساوٍ رقمًا وباطلٌ مالًا — فيُرفض. وسطرٌ بلا عملةٍ معروفة يُرفض كذلك.
 */
export function isBalanced(entry: JournalEntry): boolean {
  if (entry.lines.some((line) => !LEDGER_CURRENCIES.includes(line.currency))) return false;
  return LEDGER_CURRENCIES.every(
    (currency) => sideTotal(entry, "debit", currency) === sideTotal(entry, "credit", currency),
  );
}

/** عكس جهة كل سطر — قيد الإبطال مرآة الأصل بالضبط. */
function mirrored(lines: JournalLine[]): JournalLine[] {
  return lines.map((line) => ({ ...line, side: line.side === "debit" ? "credit" : "debit" }));
}

/** يُسقط الأسطر الصفرية (رجل مقاصة متساوية الطرفين مثلًا) — قيدٌ بلا مال لا يُكتب. */
function nonZero(lines: JournalLine[]): JournalLine[] {
  return lines.filter((line) => line.amountMinor !== 0);
}

// ── قواعد الترحيل ───────────────────────────────────────────────────────────
//
// (TD-REG-028) كل قيد بعملة مستنده الأصلية — لا مكافئ أساسي ولا سعر. والتسوية العابرة للعملات
// (دفعةٌ بعملةٍ تسدّد هدفًا بأخرى) تُقيَّد برجلين عبر مقاصة تحويل العملات (1901): رجلٌ بعملة
// الدفع بمبلغه، ورجلٌ بعملة الهدف بالمبلغ المسجَّل الذي سوّاه — وكلاهما محفوظ على المستند.

/**
 * قيد الفاتورة — بعملة الفاتورة.
 *
 * مدين ذمم المرضى بالصافي، ومدين الخصومات الممنوحة بالخصم، ودائن الإيراد بالإجمالي.
 * الخصم يُقيَّد **مصروفًا مقابلًا للإيراد** لا يُخصم من الإيراد مباشرة: صاحب العيادة
 * الذي لا يرى كم خصم لا يعرف أنه يهدي ربع دخله.
 */
export function invoiceEntry(input: {
  invoiceNumber: string;
  date: string;
  patientName: string;
  currency: Currency;
  totalMinor: number;
  discountMinor: number;
  cancelled: boolean;
}): JournalEntry | null {
  if (input.cancelled || input.totalMinor <= 0) return null;
  const currency = input.currency;
  const discount = Math.min(Math.max(0, input.discountMinor), input.totalMinor);
  const net = input.totalMinor - discount;
  const lines: JournalLine[] = [
    { accountCode: AR_ACCOUNT, currency, amountMinor: net, side: "debit" },
    { accountCode: REVENUE_ACCOUNT, currency, amountMinor: input.totalMinor, side: "credit" },
  ];
  if (discount > 0) {
    lines.push({ accountCode: DISCOUNT_ACCOUNT, currency, amountMinor: discount, side: "debit" });
  }
  return {
    source: "invoice",
    reference: input.invoiceNumber,
    date: input.date,
    description: `فاتورة ${input.patientName}`,
    lines: nonZero(lines),
  };
}

/**
 * رجلا تسويةٍ عابرة للعملات عبر المقاصة: ما دُفع بعملته، وما سُوّي بعملة هدفه.
 *
 *   عملة الدفع:  مدين المقاصة[الدفع]  / (يقابله طرفه في القيد)
 *   عملة الهدف:  دائن المقاصة[الهدف]  / (يقابله طرفه في القيد)
 *
 * يُعاد للمتصل سطرا المقاصة؛ وهو يضع سطر النقد بعملة الدفع وسطر الذمم بعملة الهدف.
 */
function clearingLegs(paid: { currency: Currency; amountMinor: number }, settled: { currency: Currency; amountMinor: number },
  paidSide: "debit" | "credit"): JournalLine[] {
  const otherSide = paidSide === "debit" ? "credit" : "debit";
  return [
    { accountCode: CURRENCY_CLEARING_ACCOUNT, currency: paid.currency, amountMinor: paid.amountMinor, side: paidSide },
    { accountCode: CURRENCY_CLEARING_ACCOUNT, currency: settled.currency, amountMinor: settled.amountMinor, side: otherSide },
  ];
}

/**
 * قيد الدفعة — بعملة الدفعة، ويُسوّي ذمم المريض بعملة هدفها.
 *
 * المبلغ المسوّى هو ما يقرؤه كشف المريض نفسه (settlePaymentMinor): بمبلغ الدفعة إن كانت بعملة
 * هدفها، وبمكافئها الأساسي المسجَّل يوم القبض إن كان الهدف بالريال اليمني. فالدفتر والكشف
 * رقمٌ واحد بالبناء. والاسترداد يعكس الأطراف ولا يُحذف قيد: **الدفاتر لا تُمحى، تُعكَس**.
 */
export function paymentEntry(input: {
  receiptNumber: string;
  date: string;
  patientName: string;
  /** عملة الدفعة ومبلغها بها. */
  currency: Currency;
  amountMinor: number;
  /** عملة هدف التسوية (فاتورة/خطة/رصيد افتتاحي) والمبلغ المسجَّل الذي سوّاه منه. */
  settlementCurrency: Currency;
  settlementMinor: number;
  kind: "payment" | "refund";
  /** (P1-3) طريقة الدفع: النقد إلى الصندوق، والتحويل إلى البنك. الغائبة = نقد. */
  method?: string | null;
}): JournalEntry | null {
  if (input.amountMinor <= 0 || input.settlementMinor <= 0) return null;
  const cash = isCashMethod(input.method) ? CASH_ACCOUNT[input.currency] : BANK_ACCOUNT[input.currency];
  const isRefund = input.kind === "refund";
  const paid = { currency: input.currency, amountMinor: input.amountMinor };
  const settled = { currency: input.settlementCurrency, amountMinor: input.settlementMinor };
  const lines: JournalLine[] = [{ accountCode: cash, ...paid, side: "debit" }];
  if (paid.currency === settled.currency && paid.amountMinor === settled.amountMinor) {
    lines.push({ accountCode: AR_ACCOUNT, ...settled, side: "credit" });
  } else {
    lines.push(...clearingLegs(paid, settled, "credit"));
    lines.push({ accountCode: AR_ACCOUNT, ...settled, side: "credit" });
  }
  return {
    source: isRefund ? "refund" : "payment",
    reference: input.receiptNumber,
    date: input.date,
    description: `${isRefund ? "استرداد إلى" : "قبض من"} ${input.patientName}`,
    lines: nonZero(isRefund ? mirrored(lines) : lines),
  };
}

/**
 * قيد الرصيد الافتتاحي لمريض — بعملة الرصيد (يمني أو سعودي أو دولار).
 *
 * مدين ذمم المرضى، دائن رأس المال والأرصدة الافتتاحية.
 *
 * **الطرف الدائن حقوق ملكية لا إيراد** — وهذا هو بيت القصيد. الطريقة السهلة أن
 * يُفتح للمريض «فاتورة سابقة» بقيمة ما عليه، فيدخل دَينٌ عمره سنتان في إيراد هذا
 * الشهر: تظهر العيادة رابحة بملايين لم تكسبها في هذه الفترة، وتُحسب عليها عمولات
 * أطباء عن عمل قديم دُفعت عمولته أصلًا، وتُبنى قرارات على ربح وهمي.
 *
 * (F-06) والرصيد بالسعودي أو الدولار يُقيَّد بعملته نفسها — لا يُحوَّل إلى يمني بسعرٍ مخمَّن
 * ولا يُسقط من الدفاتر.
 */
export function openingBalanceEntry(input: {
  patientId: number;
  date: string;
  patientName: string;
  currency: Currency;
  amountMinor: number;
}): JournalEntry | null {
  if (input.amountMinor <= 0) return null;
  const currency = input.currency;
  return {
    source: "opening",
    reference: `OB-${input.patientId}-${currency}`,
    date: input.date,
    description: `رصيد افتتاحي — ${input.patientName}`,
    lines: [
      { accountCode: AR_ACCOUNT, currency, amountMinor: input.amountMinor, side: "debit" },
      { accountCode: OPENING_EQUITY_ACCOUNT, currency, amountMinor: input.amountMinor, side: "credit" },
    ],
  };
}

function payableAccount(code?: string | null): string {
  return code && code.trim() ? code.trim() : AP_ACCOUNT;
}

function expenseAccount(category: string, code?: string | null): string {
  return code && code.trim() ? code.trim() : EXPENSE_ACCOUNT[category] ?? EXPENSE_ACCOUNT.other;
}

/**
 * (FIA-1) قيد الدَّين السابق على المركز لمختبر أو مورّد (قبل بدء النظام) — بعملة الدَّين.
 *
 * مدين «رأس المال والأرصدة الافتتاحية»، دائن الذمم الدائنة — **لا مصروف**: التكلفة تخص فترةً
 * قبل افتتاح الدفاتر، فإدخالها مصروفًا اليوم يُظهر الشهر الحالي خاسرًا بدَينٍ عمره سنة. والمبلغ
 * قيمته الفعلية بعملته (الأصل + تصحيحاته الإلحاقية) — كما يقرؤه كشف الجهة.
 */
export function openingPayableEntry(input: {
  payableId: number;
  date: string;
  partyName: string;
  currency: Currency;
  amountMinor: number;
  payableAccountCode?: string | null;
}): JournalEntry | null {
  if (input.amountMinor <= 0) return null;
  const currency = input.currency;
  return {
    source: "opening_payable",
    reference: `OP-${input.payableId}`,
    date: input.date,
    description: `دَين سابق لـ${input.partyName} (رصيد افتتاحي)`,
    lines: [
      { accountCode: OPENING_EQUITY_ACCOUNT, currency, amountMinor: input.amountMinor, side: "debit" },
      { accountCode: payableAccount(input.payableAccountCode), currency, amountMinor: input.amountMinor, side: "credit" },
    ],
  };
}

/**
 * (FIA-1) قيد الرصيد المقدَّم السابق لنا عند مختبر أو مورّد — بعملته: مدين الذمم الدائنة (رصيدٌ
 * مدين = دفعة مقدّمة)، دائن «رأس المال والأرصدة الافتتاحية». عكس الدَّين السابق — ولا مصروف.
 */
export function openingAdvanceEntry(input: {
  advanceId: number;
  date: string;
  partyName: string;
  currency: Currency;
  amountMinor: number;
  payableAccountCode?: string | null;
}): JournalEntry | null {
  if (input.amountMinor <= 0) return null;
  const currency = input.currency;
  return {
    source: "opening_advance",
    reference: `OA-${input.advanceId}`,
    date: input.date,
    description: `رصيد مقدَّم سابق لدى ${input.partyName} (رصيد افتتاحي)`,
    lines: [
      { accountCode: payableAccount(input.payableAccountCode), currency, amountMinor: input.amountMinor, side: "debit" },
      { accountCode: OPENING_EQUITY_ACCOUNT, currency, amountMinor: input.amountMinor, side: "credit" },
    ],
  };
}

/**
 * قيد الالتزام (فاتورة مورّد أو تكلفة عمل مختبر) — بعملة الالتزام.
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
  currency: Currency;
  amountMinor: number;
  /** الربط المالي (المختبرات V2): حسابات مخصصة للجهة — تُغني عن الافتراضي. */
  expenseAccountCode?: string | null;
  payableAccountCode?: string | null;
}): JournalEntry | null {
  if (input.amountMinor <= 0) return null;
  const currency = input.currency;
  return {
    source: "payable",
    reference: input.reference,
    date: input.date,
    description: `التزام لـ${input.partyName}`,
    lines: [
      { accountCode: expenseAccount(input.category, input.expenseAccountCode), currency, amountMinor: input.amountMinor, side: "debit" },
      { accountCode: payableAccount(input.payableAccountCode), currency, amountMinor: input.amountMinor, side: "credit" },
    ],
  };
}

/** قطعة تسوية التزامٍ من سند صرف: ما دُفع منه بعملة السند، وما سُوّي به بعملة الالتزام. */
export interface VoucherSettlement {
  /** بعملة السند. */
  paidMinor: number;
  payableCurrency: Currency;
  /** بعملة الالتزام — لقطة السند المسجَّلة (payable_settled_minor / التوزيع). */
  settledMinor: number;
}

/**
 * قيد الصرف — بعملة السند.
 *
 * صرفٌ **لجهة مسجّلة** (مختبر/مورّد) يُسدّد التزاماتها: مدين ذمم الموردين، دائن الصندوق. وصرفٌ
 * بلا جهة مصروفٌ مباشر: مدين حساب المصروف، دائن الصندوق.
 *
 * التمييز ضروري: لو قُيّد سداد المختبر مصروفًا لظهرت التكلفة مرتين — مرة يوم نشأ
 * الالتزام ومرة يوم سُدّد — فيبدو الشهر خاسرًا وهو ليس كذلك.
 *
 * (TD-REG-028) كل قطعة تسوية بعملة التزامها وبمبلغها المسجَّل على السند؛ فإن اختلفت عملة السند
 * عن عملة الالتزام مرّت برجلين عبر المقاصة. وما لم يُوزَّع على التزام دفعةٌ مقدّمة بعملة السند
 * — كما يقرؤها كشف الجهة تمامًا.
 *
 * (L-03) وسند الإبطال (مبالغ سالبة) **مرآة الأصل** — كان يُسقط من الدفاتر فيبقى السند المُبطَل
 * صرفًا فيها إلى الأبد.
 */
export function expenseEntry(input: {
  voucherNumber: string;
  date: string;
  payeeName: string;
  category: string;
  currency: Currency;
  /** بعملة السند؛ سالبٌ لسند الإبطال. */
  amountMinor: number;
  settlesPayable: boolean;
  /** قطع التسوية (بإشارة السند نفسها) — فارغة لسدادٍ غير مرتبط. */
  settlements?: VoucherSettlement[];
  /** الربط المالي (المختبرات V2): حسابات مخصصة للجهة — تُغني عن الافتراضي. */
  expenseAccountCode?: string | null;
  payableAccountCode?: string | null;
}): JournalEntry | null {
  if (input.amountMinor === 0) return null;
  const reversal = input.amountMinor < 0;
  const sign = reversal ? -1 : 1;
  const currency = input.currency;
  const amount = Math.abs(input.amountMinor);
  // الأطراف المدينة أولًا (مصروف أو ذمم أو مقاصة)، ثم الصندوق دائنًا — ترتيب القيد المعتاد.
  const lines: JournalLine[] = [];

  if (!input.settlesPayable) {
    lines.push({ accountCode: expenseAccount(input.category, input.expenseAccountCode), currency, amountMinor: amount, side: "debit" });
  } else {
    const ap = payableAccount(input.payableAccountCode);
    let allocated = 0;
    for (const piece of input.settlements ?? []) {
      const paid = piece.paidMinor * sign;
      const settled = piece.settledMinor * sign;
      if (paid <= 0 && settled <= 0) continue;
      allocated += paid;
      if (piece.payableCurrency === currency && paid === settled) {
        lines.push({ accountCode: ap, currency, amountMinor: paid, side: "debit" });
      } else {
        lines.push(...clearingLegs({ currency, amountMinor: paid }, { currency: piece.payableCurrency, amountMinor: settled }, "debit"));
        lines.push({ accountCode: ap, currency: piece.payableCurrency, amountMinor: settled, side: "debit" });
      }
    }
    const unallocated = amount - allocated;
    if (unallocated !== 0) {
      // دفعةٌ مقدّمة (أو ما لم يُربط بالتزام) — بعملة السند؛ وسالبها (توزيعٌ فاق السند) يبقى متوازنًا.
      lines.push({ accountCode: ap, currency, amountMinor: Math.abs(unallocated), side: unallocated > 0 ? "debit" : "credit" });
    }
  }
  lines.push({ accountCode: CASH_ACCOUNT[currency], currency, amountMinor: amount, side: "credit" });
  return {
    source: reversal ? "expense_void" : "expense",
    reference: input.voucherNumber,
    date: input.date,
    description: `${reversal ? "إبطال صرف إلى" : "صرف إلى"} ${input.payeeName}`,
    lines: nonZero(reversal ? mirrored(lines) : lines),
  };
}

/**
 * قيد فرق الجرد عند إغلاق الوردية — بعملة الدرج.
 *
 * النقص يُقيَّد مصروفًا والزيادة تُقيَّد إيرادًا سالبًا في نفس الحساب. وإثباته في
 * الدفاتر — لا تركه ملاحظةً في الوردية — هو ما يجعل رصيد الصندوق في الميزانية
 * مطابقًا لما في الدرج فعلًا. (L-06) عجزُ عشرة دولارات عشرةُ دولارات — لا سعر مشتقّ.
 */
export function cashDifferenceEntry(input: {
  shiftId: number;
  date: string;
  currency: Currency;
  differenceMinor: number;
}): JournalEntry | null {
  if (input.differenceMinor === 0) return null;
  const currency = input.currency;
  const amount = Math.abs(input.differenceMinor);
  const shortage = input.differenceMinor < 0;
  return {
    source: "cash_diff",
    reference: `SH-${input.shiftId}-${currency}`,
    date: input.date,
    description: shortage ? "عجز في جرد الصندوق" : "زيادة في جرد الصندوق",
    lines: [
      { accountCode: shortage ? CASH_DIFF_ACCOUNT : CASH_ACCOUNT[currency], currency, amountMinor: amount, side: "debit" },
      { accountCode: shortage ? CASH_ACCOUNT[currency] : CASH_DIFF_ACCOUNT, currency, amountMinor: amount, side: "credit" },
    ],
  };
}


// ── القوائم ─────────────────────────────────────────────────────────────────
//
// (TD-REG-028) كل رصيد لـ(حساب، عملة) — ولا مجموع عبر العملات في أي قائمة. ميزان كل عملة
// يتوازن وحده لأن كل قيد يتوازن داخل كل عملة؛ فقائمة الدخل والميزانية لكل عملة أيضًا.

export interface AccountBalance {
  code: string;
  name: string;
  kind: AccountKind;
  /** عملة هذا الرصيد — الحساب الواحد له رصيدٌ مستقل لكل عملة. */
  currency: Currency;
  debitMinor: number;
  creditMinor: number;
  /** الرصيد بإشارة طبيعة الحساب: موجب = الطبيعة، سالب = عكسها. */
  balanceMinor: number;
}

/** طبيعة الحساب: أصول ومصروفات مدينة، وخصوم وحقوق ملكية وإيرادات دائنة. */
export function naturalSide(kind: AccountKind): "debit" | "credit" {
  return kind === "asset" || kind === "expense" ? "debit" : "credit";
}

/** نوع الحساب من رقمه — أول خانة تحدد المجموعة المحاسبية. */
export function inferAccountKind(code: string): AccountKind {
  if (code.startsWith("1")) return "asset";
  if (code.startsWith("2")) return "liability";
  if (code.startsWith("3")) return "equity";
  if (code.startsWith("4")) return "revenue";
  return "expense";
}

/** اسم الحساب بالرقم — الاسم المخصص للجهة يسبق اسم الدليل القياسي. */
export function getAccountName(code: string, customName?: string | null): string {
  if (customName && customName.trim()) return customName.trim();
  const found = ACCOUNT_BY_CODE.get(code);
  if (found) return found.name;
  const exp = STANDARD_EXPENSE_ACCOUNTS.find((a) => a.code === code);
  if (exp) return exp.name;
  const pay = STANDARD_PAYABLE_ACCOUNTS.find((a) => a.code === code);
  if (pay) return pay.name;
  return `حساب (${code})`;
}

/**
 * ميزان المراجعة — صفٌّ لكل (حساب، عملة).
 *
 * حساب ذمم المرضى برصيد 200,000 ر.ي و1,500.00 ر.س و300.00 $ ثلاثة صفوف، لا «201,800» بلا معنى.
 */
export function trialBalance(
  entries: JournalEntry[],
  customAccounts?: { code: string; name: string; kind?: AccountKind }[],
): AccountBalance[] {
  const totals = new Map<string, { code: string; currency: Currency; debit: number; credit: number }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const key = `${line.accountCode}|${line.currency}`;
      const current = totals.get(key) ?? { code: line.accountCode, currency: line.currency, debit: 0, credit: 0 };
      if (line.side === "debit") current.debit += line.amountMinor;
      else current.credit += line.amountMinor;
      totals.set(key, current);
    }
  }

  const customMap = new Map<string, { name: string; kind: AccountKind }>();
  for (const ca of customAccounts ?? []) {
    customMap.set(ca.code, { name: ca.name, kind: ca.kind || inferAccountKind(ca.code) });
  }

  const result: AccountBalance[] = [];
  for (const value of totals.values()) {
    const custom = customMap.get(value.code);
    const standard = ACCOUNT_BY_CODE.get(value.code);
    const name = custom?.name || standard?.name || getAccountName(value.code);
    const kind = custom?.kind || standard?.kind || inferAccountKind(value.code);
    const natural = naturalSide(kind);
    result.push({
      code: value.code,
      name,
      kind,
      currency: value.currency,
      debitMinor: value.debit,
      creditMinor: value.credit,
      balanceMinor: natural === "debit" ? value.debit - value.credit : value.credit - value.debit,
    });
  }

  return result.sort((a, b) => a.code.localeCompare(b.code)
    || LEDGER_CURRENCIES.indexOf(a.currency) - LEDGER_CURRENCIES.indexOf(b.currency));
}

/** أرصدة عملةٍ واحدة من الميزان — مدخل كل قائمة. */
export function balancesIn(balances: AccountBalance[], currency: Currency): AccountBalance[] {
  return balances.filter((row) => row.currency === currency);
}

/** رصيد (حساب، عملة) — صفر إن لم يتحرك. */
export function balanceOf(balances: AccountBalance[], code: string, currency: Currency): number {
  return balances.find((row) => row.code === code && row.currency === currency)?.balanceMinor ?? 0;
}

/** العملات التي تحرّك فيها الميزان — بترتيب القوائم. */
export function activeCurrencies(balances: AccountBalance[]): Currency[] {
  return LEDGER_CURRENCIES.filter((currency) =>
    balances.some((row) => row.currency === currency && (row.debitMinor !== 0 || row.creditMinor !== 0)));
}

export interface IncomeStatement {
  /** عملة القائمة — كل مبالغها بها. */
  currency: Currency;
  revenueMinor: number;
  discountMinor: number;
  netRevenueMinor: number;
  expenses: { code: string; name: string; amountMinor: number }[];
  totalExpensesMinor: number;
  netProfitMinor: number;
}

/**
 * قائمة الدخل لعملة واحدة — على **أساس الاستحقاق**.
 *
 * الإيراد من الفواتير لا من التحصيل، والمصروف من الالتزامات لا من السداد. وهذا هو
 * المعيار المحاسبي، والفرق عملي لا نظري: عيادة فوترت مليونًا وحصّلت نصفه ربحت
 * بمقدار ما عملت لا بمقدار ما قبضت — والباقي دَينٌ في الميزانية لا خسارة.
 * (TD-REG-028) ولكل عملة قائمتها: إيراد الريال السعودي لا يُجمع مع مصروف الريال اليمني.
 */
export function incomeStatement(allBalances: AccountBalance[], currency: Currency): IncomeStatement {
  const balances = balancesIn(allBalances, currency);
  const find = (code: string) => balances.find((row) => row.code === code)?.balanceMinor ?? 0;
  const revenueMinor = find(REVENUE_ACCOUNT);
  // الخصومات حسابٌ مدين داخل مجموعة الإيرادات، فرصيده الطبيعي دائن ويظهر سالبًا.
  const discountMinor = -find(DISCOUNT_ACCOUNT);

  const expenses = balances
    .filter((row) => row.kind === "expense" && row.balanceMinor !== 0)
    .map((row) => ({ code: row.code, name: row.name, amountMinor: row.balanceMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
  const totalExpensesMinor = expenses.reduce((sum, row) => sum + row.amountMinor, 0);
  // إيرادات أخرى (حسابات مجموعة 4 غير الإيراد والخصم) تدخل صافي الإيراد كما هي.
  const otherRevenue = balances
    .filter((row) => row.kind === "revenue" && row.code !== REVENUE_ACCOUNT && row.code !== DISCOUNT_ACCOUNT)
    .reduce((sum, row) => sum + row.balanceMinor, 0);
  const netRevenueMinor = revenueMinor - discountMinor + otherRevenue;

  return {
    currency,
    revenueMinor,
    discountMinor,
    netRevenueMinor,
    expenses,
    totalExpensesMinor,
    netProfitMinor: netRevenueMinor - totalExpensesMinor,
  };
}

export interface BalanceSheet {
  /** عملة الميزانية — كل مبالغها بها. */
  currency: Currency;
  assets: { code: string; name: string; amountMinor: number }[];
  liabilities: { code: string; name: string; amountMinor: number }[];
  equity: { code: string; name: string; amountMinor: number }[];
  totalAssetsMinor: number;
  totalLiabilitiesMinor: number;
  capitalMinor: number;
  retainedEarningsMinor: number;
  equityMinor: number;
  /** الفرق بين الأصول وما يقابلها — يجب أن يكون صفرًا في كل عملة. */
  differenceMinor: number;
}

/**
 * الميزانية العمومية لعملة واحدة — مرّر أرصدة تراكمية حتى تاريخ الميزانية.
 *
 * الأصول = الخصوم + حقوق الملكية. وحقوق الملكية طرفان: **رأس المال والأرصدة
 * الافتتاحية** من حسابات المجموعة 3، و**الأرباح المتراكمة حتى تاريخ الميزانية** من قائمة الدخل التراكمية.
 *
 * قراءة حسابات المجموعة 3 من الميزان نفسه لا من وسيطٍ يُمرَّر: كان الرصيد الافتتاحي
 * يُقيَّد في الدفاتر ولا يظهر في الميزانية، فتبدو غير متوازنة بمقدار رأس المال
 * بالضبط — وهو أسوأ نوع خطأ: رقمٌ يبدو خللًا في النظام وهو خللٌ في قراءته.
 * (TD-REG-028) وكل عملة ميزانيتها — تتوازن وحدها لأن كل قيد يتوازن داخل كل عملة.
 */
export function balanceSheet(allBalances: AccountBalance[], currency: Currency): BalanceSheet {
  const balances = balancesIn(allBalances, currency);
  const pick = (kind: AccountKind) => balances
    .filter((row) => row.kind === kind && row.balanceMinor !== 0)
    .map((row) => ({ code: row.code, name: row.name, amountMinor: row.balanceMinor }));

  const assets = pick("asset");
  const liabilities = pick("liability");
  const equity = pick("equity");

  const totalAssetsMinor = assets.reduce((sum, row) => sum + row.amountMinor, 0);
  const totalLiabilitiesMinor = liabilities.reduce((sum, row) => sum + row.amountMinor, 0);
  const capitalMinor = equity.reduce((sum, row) => sum + row.amountMinor, 0);
  const retainedEarningsMinor = incomeStatement(balances, currency).netProfitMinor;
  const equityMinor = capitalMinor + retainedEarningsMinor;

  return {
    currency,
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

/** القوائم لكل عملة تحرّكت — قائمة دخل وميزانية لكلٍّ منها، بلا إجمالي عابر للعملات. */
export function statementsByCurrency(balances: AccountBalance[]): {
  currency: Currency; income: IncomeStatement; sheet: BalanceSheet;
}[] {
  return activeCurrencies(balances).map((currency) => ({
    currency,
    income: incomeStatement(balances, currency),
    sheet: balanceSheet(balances, currency),
  }));
}

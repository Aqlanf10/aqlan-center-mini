import type { Currency } from "./money";

/**
 * المصروفات وجهات التعامل — المنطق الخالص.
 *
 * المال الخارج أخطر من الداخل. الدخل يُلاحَظ غيابه — المريض دفع ولم يُسجَّل فيشتكي —
 * أما المصروف فلا يشتكي أحد من غيابه، ومبلغٌ يخرج بلا سند لا يظهر في أي جرد. وهذا
 * بالضبط كيف تضيع أموال العيادات: لا بسرقة كبيرة، بل بمئة مبلغ صغير بلا ورقة.
 */

export type StandardExpenseCategory =
  | "lab"        // مستحقات المعامل
  | "supplier"   // موردون
  | "materials"  // مواد ومستهلكات
  | "commission" // عمولات أطباء
  | "salary"     // رواتب
  | "rent"       // إيجار وخدمات
  | "electricity" // كهرباء ومياه ومحروقات
  | "maintenance" // صيانة أجهزة وكراسي
  | "equipment_parts" // قطع غيار
  | "internet"   // إنترنت واتصالات
  | "cleaning_hospitality" // نظافة وضيافة
  | "facility_maintenance" // صيانة المقر والسباكة
  | "marketing"  // تسويق ودعاية
  | "other";

export type ExpenseCategory = StandardExpenseCategory | (string & {});

export const EXPENSE_CATEGORIES: string[] = [
  "electricity",
  "maintenance",
  "equipment_parts",
  "internet",
  "rent",
  "cleaning_hospitality",
  "facility_maintenance",
  "marketing",
  "materials",
  "lab",
  "salary",
  "commission",
  "supplier",
  "other",
];

export const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  electricity: "الكهرباء والماء والمولد",
  maintenance: "صيانة الأجهزة والكراسي",
  equipment_parts: "قطع الغيار والمعدات",
  internet: "الإنترنت والاتصالات",
  rent: "إيجار المركز والمقر",
  cleaning_hospitality: "النظافة والضيافة والمستلزمات",
  facility_maintenance: "صيانة المقر والسباكة",
  marketing: "التسويق والدعاية والإعلانات",
  materials: "مواد ومستهلكات طبية",
  lab: "المختبر وتكاليف التركيبات",
  supplier: "موردون",
  commission: "عمولات أطباء الأسنان",
  salary: "رواتب ومكافآت الكادر",
  other: "أخرى ونثريات",
};

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_-]{2,64}$/.test(trimmed);
}

export type PartyKind = "lab" | "supplier" | "doctor";

export const PARTY_KIND_LABEL: Record<PartyKind, string> = {
  lab: "مختبر",
  supplier: "مورّد",
  doctor: "طبيب",
};

export function isPartyKind(value: unknown): value is PartyKind {
  return value === "lab" || value === "supplier" || value === "doctor";
}

/** التصنيف الذي يناسب جهةً من نوع معيّن — يُستعمل لاقتراح التصنيف عند اختيار الجهة. */
export function categoryForParty(kind: PartyKind): ExpenseCategory {
  return kind === "lab" ? "lab" : kind === "doctor" ? "commission" : "supplier";
}

export interface ExpenseLike {
  category: ExpenseCategory;
  amountMinor: number;
  currency: Currency;
  baseAmountMinor: number;
}

export interface ExpenseTotals {
  byCategory: Record<ExpenseCategory, number>;
  byCurrency: Record<Currency, number>;
  baseTotalMinor: number;
  count: number;
}

export function expenseTotals(expenses: ExpenseLike[]): ExpenseTotals {
  const byCategory = Object.fromEntries(
    EXPENSE_CATEGORIES.map((category) => [category, 0]),
  ) as Record<ExpenseCategory, number>;
  const byCurrency: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
  let baseTotalMinor = 0;

  for (const expense of expenses) {
    const cat = expense.category || "other";
    byCategory[cat] = (byCategory[cat] ?? 0) + expense.baseAmountMinor;
    byCurrency[expense.currency] = (byCurrency[expense.currency] ?? 0) + expense.amountMinor;
    baseTotalMinor += expense.baseAmountMinor;
  }
  return { byCategory, byCurrency, baseTotalMinor, count: expenses.length };
}

/**
 * ما يجب أن يكون في الصندوق لكل عملة.
 *
 * الافتتاحي زائد المقبوض ناقص المصروف. حساب الجرد بلا طرح المصروفات هو أشيع خطأ في
 * إغلاق الصناديق: كل إغلاق يبدو ناقصًا بمقدار ما صُرف، فيُتجاهل الفرق بعد أسبوع
 * ويصير الجرد بلا فائدة.
 */
export function expectedInBox(
  opening: Record<Currency, number>,
  collected: Record<Currency, number>,
  spent: Record<Currency, number>,
): Record<Currency, number> {
  return {
    YER: opening.YER + collected.YER - spent.YER,
    SAR: opening.SAR + collected.SAR - spent.SAR,
    USD: opening.USD + collected.USD - spent.USD,
  };
}

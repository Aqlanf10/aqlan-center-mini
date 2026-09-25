/**
 * (P2-1) حدود الدورين الجديدين — الكاشير والمحاسب — بقائمة سماح لا قائمة منع.
 *
 * الأدوار الثلاثة القديمة تُحرس في كل مسار بفحوصه (المدير، الاستقبال، الطبيب بعزله).
 * والدوران الجديدان أضيق من الاستقبال عمدًا، وكثيرٌ من المسارات يكتفي بسؤال «هل
 * معك جلسة؟» — فلو دخلا بهذه القاعدة لرأى الكاشير الملف السريري كاملًا. لذلك
 * يُحرسان **عند الباب** (proxy) بقائمة ما يصلان إليه، وكل ما عداها مرفوض:
 * مسارٌ جديد يُضاف غدًا لا يصل إليه أيّهما حتى يُضاف هنا بقرار.
 *
 * - **الكاشير**: الصندوق وحده — فتح الوردية وإقفالها، سند القبض، سند الصرف،
 *   البحث عن المريض وكشف حسابه، وطباعة سنداته. لا ملف سريري ولا مواعيد ولا إعدادات
 *   ولا تقارير دخل.
 * - **المحاسب**: القراءة المالية كاملة — الفواتير والسندات والورديات والمصروفات
 *   والموردين والدفاتر والعمولات والتقارير المالية — **بلا تحصيل ولا صرف ولا إلغاء**.
 *   وما يكتبه: بنود المصروفات وميزانياتها، وتقاريره المحفوظة. لا ملف سريري.
 *
 * دالة خالصة بلا قاعدة: تُختبر بجدول، وتُستدعى في الباب لكل طلب.
 */

export type RestrictedRole = "cashier" | "accountant";

export const RESTRICTED_ROLES: readonly RestrictedRole[] = ["cashier", "accountant"];

export function isRestrictedRole(role: string | null | undefined): role is RestrictedRole {
  return role === "cashier" || role === "accountant";
}

/** الصفحة التي يبدأ منها الدور — وإليها يُعاد من طلب صفحةً خارج حدوده. */
export const ROLE_HOME: Record<RestrictedRole, string> = {
  cashier: "/finance",
  accountant: "/finance",
};

type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | string;

interface Rule {
  /** مسارٌ بعينه، أو بادئة تنتهي بـ«/» تشمل ما تحتها. و«[id]» مقطعٌ رقمي. */
  path: string;
  /** الأفعال المسموحة؛ الغياب = القراءة وحدها. */
  methods?: readonly Method[];
}

const READ: readonly Method[] = ["GET", "HEAD"];

/** ما يشترك فيه كل دور: الحساب الشخصي وكلمة المرور. */
const COMMON: Rule[] = [
  { path: "/account" },
  { path: "/api/auth/password", methods: ["POST"] },
];

/** السندات المطبوعة المالية — القراءة وحدها. */
const MONEY_PRINTS: Rule[] = [
  { path: "/print/receipt/[id]" },
  { path: "/print/invoice/[id]" },
  { path: "/print/statement/[id]" },
  { path: "/print/shift/[id]" },
  { path: "/print/voucher/[id]" },
];

const RULES: Record<RestrictedRole, Rule[]> = {
  cashier: [
    ...COMMON,
    ...MONEY_PRINTS,
    { path: "/finance" },
    { path: "/api/shifts", methods: ["GET", "POST", "PATCH"] },
    { path: "/api/payments", methods: ["GET", "POST"] },
    { path: "/api/invoices" },
    { path: "/api/invoices/[id]" },
    { path: "/api/expenses", methods: ["GET", "POST"] },
    { path: "/api/expenses/quote", methods: ["POST"] },
    { path: "/api/expenses/[id]/attachments", methods: ["GET", "POST"] },
    { path: "/api/expense-attachments/[id]" },
    { path: "/api/finance/expense-categories" },
    { path: "/api/finance/debts" },
    { path: "/api/parties" },
    // البحث عن المريض لقبض دفعته، وكشف حسابه — لا ملفه.
    { path: "/api/patients" },
    { path: "/api/patients/[id]/ledger" },
    { path: "/api/print-log", methods: ["POST"] },
  ],
  accountant: [
    ...COMMON,
    ...MONEY_PRINTS,
    { path: "/print/party/[id]" },
    { path: "/finance" },
    { path: "/finance/" },
    { path: "/reports" },
    { path: "/api/shifts" },
    { path: "/api/payments" },
    { path: "/api/invoices" },
    { path: "/api/invoices/[id]" },
    { path: "/api/expenses" },
    { path: "/api/expenses/[id]/attachments" },
    { path: "/api/expense-attachments/[id]" },
    { path: "/api/payables" },
    { path: "/api/finance/debts" },
    { path: "/api/finance/reconciliation" },
    { path: "/api/finance/lab-accounting" },
    { path: "/api/finance/lab-reconciliation" },
    { path: "/api/finance/report" },
    { path: "/api/finance/commissions" },
    { path: "/api/finance/fx" },
    { path: "/api/finance/expense-categories", methods: ["GET", "POST", "PATCH", "DELETE"] },
    { path: "/api/accounting" },
    { path: "/api/opening-balances" },
    { path: "/api/parties" },
    { path: "/api/services" },
    { path: "/api/patients" },
    { path: "/api/patients/[id]/ledger" },
    { path: "/api/reports" },
    { path: "/api/reports/saved", methods: ["GET", "POST", "PATCH", "DELETE"] },
    { path: "/api/print-log", methods: ["POST"] },
  ],
};

function matches(rulePath: string, pathname: string): boolean {
  if (rulePath.endsWith("/")) return pathname.startsWith(rulePath);
  const ruleParts = rulePath.split("/");
  const parts = pathname.replace(/\/+$/, "").split("/");
  if (ruleParts.length !== parts.length) return false;
  return ruleParts.every((part, index) => (part === "[id]" ? /^\d+$/.test(parts[index]) : part === parts[index]));
}

/**
 * هل يصل الدور المقيَّد إلى هذا المسار بهذا الفعل؟ للأدوار الأخرى دائمًا نعم —
 * حراستها في مساراتها كما كانت.
 */
export function restrictedRouteAllowed(role: string | null | undefined, pathname: string, method: Method): boolean {
  if (!isRestrictedRole(role)) return true;
  const verb = method.toUpperCase();
  return RULES[role].some((rule) => matches(rule.path, pathname) && (rule.methods ?? READ).includes(verb));
}

/** للقائمة الجانبية: هل تُعرض هذه الصفحة للدور؟ */
export function pageVisibleToRole(role: string | null | undefined, href: string): boolean {
  return restrictedRouteAllowed(role, href, "GET");
}

export const RESTRICTED_ROUTE_DENIED = "هذا القسم خارج صلاحيات دورك.";

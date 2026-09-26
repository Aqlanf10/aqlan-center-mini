/**
 * الأدوار والصلاحيات.
 *
 * وجود الأدوار بلا شاشة لإنشاء المستخدمين كان عيبًا صامتًا: كل من في العيادة يدخل
 * بحساب المدير الوحيد، فتصير كل فحوص الصلاحيات بلا معنى — و«من استلم المبلغ» في كل
 * سند اسمًا واحدًا مهما اختلف من استلمه.
 *
 * ثلاثة أدوار تكفي عيادة بكرسيين، وزيادتها تعقيدٌ بلا مقابل:
 *
 * - **المدير**: كل شيء، ومنه ما لا يراه غيره — دخل العيادة، الأسعار، العمولات،
 *   الإعدادات، إلغاء الفواتير.
 * - **الاستقبال**: التشغيل اليومي والصندوق والفواتير والدفعات. لا ترى تقارير الدخل
 *   ولا العمولات: هي تقبض وتصرف بسند، ولا شأن لها بربح العيادة.
 * - **الطبيب**: التشغيل وحده — اللوحة والمرضى والمواعيد والمختبر والمتابعة. لا صندوق
 *   ولا فواتير: الطبيب يعالج، والمال ليس عمله، وإطلاعه على دخل العيادة يفتح بابًا
 *   لا يُغلق.
 *
 * (P2-1 — قرار المالك) ودوران أضيق من الاستقبال، حدودهما قائمة سماح عند الباب
 * (`lib/role-routes.ts`) لا فحوصٌ متناثرة:
 *
 * - **الكاشير**: الصندوق وحده — الوردية وسند القبض وسند الصرف وكشف حساب المريض.
 *   لا ملف سريري ولا مواعيد ولا إعدادات ولا تقارير دخل.
 * - **المحاسب**: يقرأ المالية كلها وتقاريرها — ولا يقبض ولا يصرف ولا يلغي. لا ملف سريري.
 */

export type Role = "admin" | "reception" | "doctor" | "cashier" | "accountant";

export const ROLES: Role[] = ["admin", "reception", "doctor", "cashier", "accountant"];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "مدير",
  reception: "استقبال",
  doctor: "طبيب",
  cashier: "كاشير",
  accountant: "محاسب",
};

export const ROLE_HINT: Record<Role, string> = {
  admin: "كل شيء: التقارير والأسعار والعمولات والإعدادات",
  reception: "التشغيل والصندوق والفواتير — بلا تقارير دخل",
  doctor: "التشغيل وحده — بلا صندوق ولا فواتير",
  cashier: "الصندوق وحده: الوردية والقبض والصرف — بلا ملف سريري",
  accountant: "قراءة المالية وتقاريرها — بلا قبض ولا صرف ولا ملف سريري",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

/** المدير وحده: ما يكشف ربح العيادة أو يغيّر قواعدها. */
export function isAdmin(role: string | undefined | null): boolean {
  return role === "admin";
}

/** من يلمس المال (يقبض ويصرف): المدير والاستقبال والكاشير. الطبيب والمحاسب لا. */
export function canHandleMoney(role: string | undefined | null): boolean {
  return role === "admin" || role === "reception" || role === "cashier";
}

/**
 * (P2-1) من **يقرأ** المال: من يلمسه، والمحاسب. للقراءة وحدها — كل كتابةٍ مالية
 * تبقى خلف `canHandleMoney`، فالمحاسب يرى السند ولا يصدره.
 */
export function canViewMoney(role: string | undefined | null): boolean {
  return canHandleMoney(role) || role === "accountant";
}

/**
 * (P2-1) التقارير المالية الإدارية (الدخل، الدفاتر، العمولات، الأرصدة الافتتاحية،
 * أسعار الصرف): المدير يقرأ ويكتب، والمحاسب يقرأ.
 */
export function canViewFinancialReports(role: string | undefined | null): boolean {
  return role === "admin" || role === "accountant";
}

/**
 * إدارة المخزون: البنود والشراء والتسويات — للمدير والاستقبال. الطبيب يرى
 * المخزون ويسجّل استهلاكه (صرفًا) دون أن يفتح بنودًا أو يسوّي أرصدة: التسوية
 * أقرب الحركات للمال فصاحبها من يحاسب على الجرد.
 */
export function canManageInventory(role: string | undefined | null): boolean {
  return role === "admin" || role === "reception";
}

/**
 * استخدام المساعد الذكي وبوت الشات في العيادة:
 * - المدير: مسموح دائمًا.
 * - الطبيب: مسموح افتراضيًا (ما لم يُعطّل صراحة في الصلاحيات).
 * - الاستقبال: محجوب افتراضيًا، ويُتاح فقط إذا فُعّل صراحة من قبل الإدارة.
 */
export function canUseAiChat(
  role: string | undefined | null,
  permissions?: { canUseAiChat?: boolean } | null,
): boolean {
  if (role === "admin") return true;
  if (permissions && typeof permissions.canUseAiChat === "boolean") {
    return permissions.canUseAiChat;
  }
  // الافتراضي حسب الدور: الطبيب مفعّل، الاستقبال معطّل
  if (role === "doctor") return true;
  return false;
}


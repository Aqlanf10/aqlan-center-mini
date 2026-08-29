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
 */

export type Role = "admin" | "reception" | "doctor";

export const ROLES: Role[] = ["admin", "reception", "doctor"];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "مدير",
  reception: "استقبال",
  doctor: "طبيب",
};

export const ROLE_HINT: Record<Role, string> = {
  admin: "كل شيء: التقارير والأسعار والعمولات والإعدادات",
  reception: "التشغيل والصندوق والفواتير — بلا تقارير دخل",
  doctor: "التشغيل وحده — بلا صندوق ولا فواتير",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as string[]).includes(value);
}

/** المدير وحده: ما يكشف ربح العيادة أو يغيّر قواعدها. */
export function isAdmin(role: string | undefined | null): boolean {
  return role === "admin";
}

/** من يلمس المال: المدير والاستقبال. الطبيب لا. */
export function canHandleMoney(role: string | undefined | null): boolean {
  return role === "admin" || role === "reception";
}

/**
 * إدارة المخزون: البنود والشراء والتسويات — للمدير والاستقبال. الطبيب يرى
 * المخزون ويسجّل استهلاكه (صرفًا) دون أن يفتح بنودًا أو يسوّي أرصدة: التسوية
 * أقرب الحركات للمال فصاحبها من يحاسب على الجرد.
 */
export function canManageInventory(role: string | undefined | null): boolean {
  return role === "admin" || role === "reception";
}

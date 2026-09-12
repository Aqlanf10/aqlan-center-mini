/**
 * صلاحيات الإعدادات — فوق نموذج الأدوار القائم لا بديلًا عنه.
 *
 * المشروع يملك ثلاثة أدوار و«صلاحيات طبيب» لكل مستخدم. هذا الملفّ لا يخترع نموذجًا
 * ثانيًا: يترجم الفئة إلى صلاحيةٍ لازمة، ويسأل النموذج القائم هل يملكها الفاعل.
 *
 * والقاعدة التي يفرضها: **الاستقبال التي تفتح «إعدادات عامة» لا تفتح «المالية»**.
 * تدرّجُ الصلاحية بالفئة لا بالشاشة، لأن الشاشة تُتجاوز والمسار لا يُتجاوز.
 */
import type { Role } from "./roles";
import { CATEGORY_LABEL, type SettingCategory, type SettingPermission } from "./settings-definitions";

export type SettingsAction = SettingPermission | "settings.view" | "settings.view_history";

/** الصلاحية اللازمة لإدارة كل فئة. */
export const CATEGORY_PERMISSION: Record<SettingCategory, SettingPermission> = {
  general: "settings.manage",
  hours: "settings.manage",
  scheduling: "settings.manage",
  visit_types: "settings.manage",
  capacity: "settings.manage",
  patient_workflow: "settings.manage",
  clinical: "settings.manage",
  ortho: "settings.manage",
  finance: "settings.manage_finance",
  reception: "settings.manage",
  messaging: "settings.manage",
  complaints: "settings.manage",
  daily_closing: "settings.manage",
  reports: "settings.manage",
  staff: "settings.manage_permissions",
  branding: "settings.manage",
  backup: "settings.manage_backup",
  integrations: "settings.manage_integrations",
  feature_flags: "settings.manage",
  system: "settings.manage",
};

/**
 * ما يملكه كل دور اليوم.
 *
 * المدير يملك كل شيء — وهذا هو السلوك القائم قبل هذه المرحلة، فلا يُضيَّق عليه.
 * والاستقبال والطبيب يقرآن ولا يكتبان: كانا كذلك فعلًا (المسار يرفض غير المدير)،
 * والجديد أن القراءة صارت صلاحيةً مسمّاة بدل أن تكون «كلّ من يملك جلسة».
 */
const ROLE_ACTIONS: Record<Role, readonly SettingsAction[]> = {
  admin: [
    "settings.view",
    "settings.view_history",
    "settings.manage",
    "settings.manage_finance",
    "settings.manage_permissions",
    "settings.manage_integrations",
    "settings.manage_backup",
  ],
  reception: ["settings.view"],
  doctor: ["settings.view"],
};

export function roleCan(role: string | null | undefined, action: SettingsAction): boolean {
  const actions = ROLE_ACTIONS[(role ?? "") as Role];
  return actions ? actions.includes(action) : false;
}

export function canManageCategory(role: string | null | undefined, category: SettingCategory): boolean {
  return roleCan(role, CATEGORY_PERMISSION[category]);
}

/** رسالة الرفض تسمّي الفئة — «ممنوع» وحدها لا تقول للمستخدم ما يطلبه من مديره. */
export function denialMessage(category: SettingCategory): string {
  return `تعديل إعدادات «${CATEGORY_LABEL[category]}» يحتاج صلاحيةً أعلى.`;
}

/**
 * حمولة تدقيق تغيير الإعدادات — تشكيلٌ خالص، قابلٌ للاختبار بلا قاعدة.
 *
 * **لماذا فعلٌ جديد لا `settings.update` القديم؟** لأن الاسم القديم مُثقَل: تستعمله
 * مسارات المختبرات ومحاسبة المختبرات أيضًا. فسجلٌّ يُبنى على الاسم وحده يخلط تغيير
 * سعر الصرف بإنشاء مختبر. والحلّ **تمييزٌ مزدوج** لا اسمٌ فقط:
 *
 *   `action` = `clinic_settings.update` (أو `.reset`)
 *   `entity` = `clinic_setting`
 *   `entity_id` = مفتاح الإعداد
 *
 * فيُستخرج السجلّ بشرطٍ على العمودين معًا، ويبقى تاريخ المختبرات كما هو حرفًا بحرف —
 * لم يُعَد كتابة سجلٍّ قديم ولم تتغيّر دلالة مسارٍ قائم.
 *
 * وصفٌّ لكل مفتاح لا صفٌّ لكل طلب: القيمة قبل وبعد لا معنى لهما في صفٍّ يحمل عشرة
 * مفاتيح، و`entity_id` لا يحمل إلا مفتاحًا واحدًا.
 */
import type { SettingDefinition } from "./settings-definitions";

export const SETTINGS_AUDIT_ENTITY = "clinic_setting";
export const SETTINGS_AUDIT_UPDATE = "clinic_settings.update";
export const SETTINGS_AUDIT_RESET = "clinic_settings.reset";
export const SETTINGS_AUDIT_SECRET_REPLACE = "clinic_settings.secret.replace";
export const SETTINGS_AUDIT_SECRET_REMOVE = "clinic_settings.secret.remove";

/** أقصى طولٍ لقيمةٍ تُنقل إلى السجل — سجلٌّ لا يُحذف منه ليس مخزنًا بلا حدّ. */
export const AUDIT_VALUE_MAX = 500;

/** حالة السرّ — تُسجَّل الحالة لا القيمة، أبدًا. */
export type SecretState = "NOT_CONFIGURED" | "CONFIGURED" | "REPLACED" | "REMOVED";

export function secretTransition(before: string, after: string): SecretState {
  const had = before.trim() !== "";
  const has = after.trim() !== "";
  if (!had && has) return "CONFIGURED";
  if (had && !has) return "REMOVED";
  if (had && has) return "REPLACED";
  return "NOT_CONFIGURED";
}

/** يقصّ القيمة الطويلة ويقول إنها قُصّت — لا يبتلعها صامتًا. */
export function boundValue(raw: string): string {
  if (raw.length <= AUDIT_VALUE_MAX) return raw;
  return `${raw.slice(0, AUDIT_VALUE_MAX)}… (قُصَّ ${raw.length - AUDIT_VALUE_MAX} حرفًا)`;
}

export interface SettingAuditDetails extends Record<string, unknown> {
  المفتاح: string;
  الفئة: string;
  المدى: string;
  قبل?: string;
  بعد?: string;
  الحالة?: SecretState;
  السبب?: string;
}

/**
 * يبني تفاصيل الصفّ.
 *
 * والسرّ لا تُكتب قيمته قبل ولا بعد — ولا مقنّعةً ولا مقصوصة: القناع يكشف الطول،
 * والطول يكشف نوع المفتاح. تُكتب الحالة المعنوية وحدها.
 */
export function settingAuditDetails(input: {
  definition: SettingDefinition;
  before: string;
  after: string;
  reason?: string | null;
}): SettingAuditDetails {
  const { definition, before, after } = input;
  const details: SettingAuditDetails = {
    المفتاح: definition.key,
    الفئة: definition.category,
    المدى: definition.scope,
  };
  if (definition.sensitivity === "secret") {
    details.الحالة = secretTransition(before, after);
  } else {
    details.قبل = boundValue(before);
    details.بعد = boundValue(after);
  }
  const reason = (input.reason ?? "").trim();
  if (reason) details.السبب = boundValue(reason);
  return details;
}

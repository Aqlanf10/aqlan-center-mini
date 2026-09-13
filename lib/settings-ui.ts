import type { SettingDefinition } from "./settings-definitions";

export type SettingControlKind = "toggle" | "number" | "select" | "time" | "date" | "textarea" | "text";

const ENUM_LABELS: Record<string, string> = {
  true: "مفعّل",
  false: "متوقف",
  on: "مفعّل",
  off: "متوقف",
  YER: "ريال يمني (YER)",
  SAR: "ريال سعودي (SAR)",
  USD: "دولار أمريكي (USD)",
  first_only: "الاسم الأول فقط",
  first_initial: "الاسم الأول + الحرف الأول",
};

export function settingControlKind(definition: SettingDefinition): SettingControlKind {
  switch (definition.type) {
    case "BOOLEAN": return "toggle";
    case "INTEGER":
    case "DECIMAL":
    case "DURATION_MINUTES":
    case "DURATION_DAYS":
    case "DURATION_WEEKS": return "number";
    case "ENUM": return "select";
    case "TIME": return "time";
    case "DATE": return "date";
    case "TEMPLATE":
    case "LIST":
    case "JSON": return "textarea";
    default: return "text";
  }
}

export function isDefaultSettingValue(definition: SettingDefinition, value: string | undefined): boolean {
  return (value ?? definition.defaultValue) === definition.defaultValue;
}

export function optionLabel(value: string): string {
  return ENUM_LABELS[value] ?? value;
}

export function formatSettingValue(
  definition: SettingDefinition,
  value: string | undefined,
  secretConfigured = false,
): string {
  if (definition.sensitivity === "secret") return secretConfigured ? "مُهيّأ" : "غير مُهيّأ";
  const raw = value ?? definition.defaultValue;
  if (definition.type === "BOOLEAN" || definition.type === "ENUM") return optionLabel(raw);
  if (raw.trim() === "") return "غير محدد";
  return definition.unit ? `${raw} ${definition.unit}` : raw;
}

export function secretStateLabel(state: string | null | undefined): string {
  switch (state) {
    case "CONFIGURED": return "تمت التهيئة";
    case "REPLACED": return "تم الاستبدال";
    case "REMOVED": return "تمت الإزالة";
    case "NOT_CONFIGURED": return "غير مُهيّأ";
    default: return "تغيير سرّي";
  }
}

export function historyActionLabel(action: string): string {
  switch (action) {
    case "clinic_settings.update": return "تعديل";
    case "clinic_settings.reset": return "إعادة إلى الافتراضي";
    case "clinic_settings.secret.replace": return "استبدال سر";
    case "clinic_settings.secret.remove": return "إزالة سر";
    default: return action;
  }
}

export function canRestoreHistoryValue(definition: SettingDefinition | null, value: string | null): boolean {
  return Boolean(definition && !definition.systemLocked && definition.sensitivity !== "secret" && value !== null);
}

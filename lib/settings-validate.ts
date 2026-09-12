/**
 * التحقّق الخادميّ من قيم الإعدادات — الفرض هنا لا في الشاشة.
 *
 * تحقّق الواجهة راحةٌ للمستخدم؛ وحده تحقّق الخادم حمايةٌ للنظام: الشاشة تُتجاوز
 * بطلبٍ واحد من الطرفية، والقيمة الفاسدة تدخل الجدول فتفسد كل حسابٍ يقرؤها.
 *
 * والرسائل عربية تسمّي الحقل والسبب: «قيمة غير صالحة» وحدها تترك المالك يفتّش في
 * ثمانيةٍ وثلاثين حقلًا.
 */
import { settingDefinition, type SettingDefinition } from "./settings-definitions";
import { validateSetting as validateLegacy } from "./settings";
import { isKnownZone } from "./clinicZone";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function integerProblem(definition: SettingDefinition, raw: string): string | null {
  const value = Number(raw);
  if (!Number.isInteger(value)) return `${definition.label}: القيمة رقمٌ صحيح.`;
  if (definition.min != null && value < definition.min) {
    return `${definition.label}: أقلّ قيمة ${definition.min}${definition.unit ? ` ${definition.unit}` : ""}.`;
  }
  if (definition.max != null && value > definition.max) {
    return `${definition.label}: أكبر قيمة ${definition.max}${definition.unit ? ` ${definition.unit}` : ""}.`;
  }
  return null;
}

/**
 * يفحص قيمةً واحدة بحسب نوعها المعرَّف.
 *
 * يُستدعى معه التحقّق القديم (`validateSetting`) دائمًا: قواعده الخاصّة بمفاتيح
 * بعينها — سعر الصرف، وصيغة القفل المالي — أدقّ من النوع العام، وإسقاطها لأجل
 * «نموذج أنظف» يفتح ما كان مغلقًا.
 */
export function validateTypedSetting(key: string, raw: string): string | null {
  const definition = settingDefinition(key);
  if (!definition) return "مفتاح إعداد غير معروف.";
  if (definition.systemLocked) return `${definition.label}: ثابتُ نظامٍ لا يُغيَّر من الإعدادات.`;

  const value = raw.trim();

  switch (definition.type) {
    case "BOOLEAN":
      if (value !== "true" && value !== "false") return `${definition.label}: القيمة true أو false.`;
      break;
    case "INTEGER":
    case "DURATION_MINUTES":
    case "DURATION_DAYS":
    case "DURATION_WEEKS": {
      const problem = integerProblem(definition, value);
      if (problem) return problem;
      break;
    }
    case "DECIMAL": {
      const number = Number(value);
      if (!Number.isFinite(number)) return `${definition.label}: القيمة رقم.`;
      if (definition.min != null && number < definition.min) {
        return `${definition.label}: أقلّ قيمة ${definition.min}.`;
      }
      if (definition.max != null && number > definition.max) {
        return `${definition.label}: أكبر قيمة ${definition.max}.`;
      }
      break;
    }
    case "ENUM":
      if (!definition.options?.includes(value)) {
        return `${definition.label}: القيمة إحدى (${(definition.options ?? []).join(" · ")}).`;
      }
      break;
    case "TIME":
      if (!TIME.test(value)) return `${definition.label}: الوقت بصيغة 08:30.`;
      break;
    case "DATE":
      // الفارغ مقصود في بعض المفاتيح (قفل الدفاتر) — والقديم يحكم عليه.
      if (value !== "" && !DATE.test(value)) return `${definition.label}: التاريخ بصيغة 2026-01-31.`;
      break;
    case "LIST":
      if (value.split(",").some((part) => part.trim() === "")) {
        return `${definition.label}: قائمة مفصولة بفواصل بلا عناصر فارغة.`;
      }
      break;
    case "JSON":
      try { JSON.parse(value); } catch { return `${definition.label}: القيمة JSON صالح.`; }
      break;
    case "TEMPLATE":
    case "STRING":
      break;
  }

  if (key === "backup.schedule_timezone" && value !== "" && !isKnownZone(value)) {
    return `${definition.label}: منطقة زمنية غير معروفة.`;
  }

  return validateLegacy(key as never, raw);
}

/**
 * قيود تتجاوز المفتاح الواحد.
 *
 * «الانتظار الحرج» أكبر من «تحذير الانتظار» — قاعدةٌ لا يراها فحصُ مفتاحٍ منفرد،
 * وكسرُها يجعل كل صفٍّ أحمرَ من أوّل دقيقة فتفقد الألوان معناها.
 */
export function validateSettingSet(
  next: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): string | null {
  const read = (key: string): number => Number(next[key] ?? current[key] ?? "0");
  const touchesWait = "ops.wait_warning_minutes" in next || "ops.wait_critical_minutes" in next;
  if (touchesWait && read("ops.wait_critical_minutes") <= read("ops.wait_warning_minutes")) {
    return "الانتظار الحرج يجب أن يكون أكبر من تحذير الانتظار.";
  }
  const touchesDay = "clinic.day_start" in next || "clinic.day_end" in next;
  if (touchesDay) {
    const start = next["clinic.day_start"] ?? current["clinic.day_start"] ?? "";
    const end = next["clinic.day_end"] ?? current["clinic.day_end"] ?? "";
    if (TIME.test(start) && TIME.test(end) && end <= start) {
      return "نهاية الدوام يجب أن تكون بعد بدايته.";
    }
  }
  return null;
}

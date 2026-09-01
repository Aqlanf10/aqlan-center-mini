/**
 * إعدادات المركز — مصدر واحد لكل قيمة قابلة للتغيير.
 *
 * القاعدة التي تحكم هذا الملف: **لا قيمة تشغيلية أو مالية مكتوبة في الكود**. عدد
 * الكراسي صار ثلاثة؟ سعر الصرف تغيّر اليوم؟ اسم المركز يُطبع على السند؟ كلها تُضبط
 * من شاشة الإعدادات لا بنشرة برمجية جديدة — والفرق بينهما في عيادة تعمل: دقيقة
 * مقابل يوم.
 *
 * وهذا صار لازمًا لا تحسينًا: البرنامج انتقل من أداة طوارئ مؤقتة إلى النظام الأساسي
 * لأربعة أشهر، وقيمةٌ مكتوبة في الكود اليوم هي مكالمة هاتفية بعد شهر.
 */

export type SettingKey =
  | "clinic.name"
  | "clinic.lead_doctor"
  | "clinic.lead_doctor_title"
  | "clinic.lead_doctor_credentials"
  | "clinic.phone"
  | "clinic.address"
  | "clinic.chairs"
  | "clinic.day_start"
  | "clinic.day_end"
  | "finance.base_currency"
  | "finance.rate.SAR"
  | "finance.rate.USD"
  | "finance.locked_before"
  | "lab.default_days"
  | "recall.lapse_weeks"
  | "documents.max_megabytes"
  | "workflow.doctor_financial_view"
  | "display.privacy_mode"
  | "display.voice"
  | "display.delay_notice"
  | "display.show_ortho"
  | "display.announcements"
  | "display.tagline";

/**
 * القيم الافتراضية.
 *
 * ليست «قيمًا مكتوبة في الكود» بالمعنى الممنوع: هي ما يعمل به البرنامج **قبل** أن
 * يضبط أحدٌ شيئًا، فلا تُفتح الشاشة فارغة يوم التنصيب. أي قيمة في الجدول تغلبها.
 */
export const SETTING_DEFAULTS: Record<SettingKey, string> = {
  "clinic.name": "مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان",
  "clinic.lead_doctor": "د. عقلان الكامل",
  "clinic.lead_doctor_title": "أخصائي تقويم الأسنان",
  "clinic.lead_doctor_credentials": "جامعة مانيلا المركزية — الفلبين",
  "clinic.phone": "04-253028",
  "clinic.address": "تعز — الجمهورية اليمنية",
  "clinic.chairs": "2",
  "clinic.day_start": "09:00",
  "clinic.day_end": "21:00",
  "finance.base_currency": "YER",
  // أسعار الصرف تتغيّر في اليمن أسبوعيًا وأحيانًا يوميًا. القيمة هنا نقطة بداية
  // تُصحَّح من الشاشة في أول يوم عمل — ولا تُستخدم في حساب دفعة سابقة إطلاقًا.
  "finance.rate.SAR": "140",
  "finance.rate.USD": "530",
  // فارغ = لا قفل. يُملأ بتاريخ فيصير كل ما قبله مقفلًا لا يُعدَّل.
  "finance.locked_before": "",
  "lab.default_days": "7",
  "recall.lapse_weeks": "6",
  // هل يرى الطبيب الرصيد المالي لمريضه في ملفه؟ افتراضيًا لا: الطبيب يعالج
  // والمال ليس عمله (راجع أدوار النظام). الإدارة تفعّله إن شاءت من الإعدادات —
  // والفحص في الخادم لا في الشاشة.
  "workflow.doctor_financial_view": "false",
  // عشرون ميغابايت تكفي أشعةً بانورامية بجودةٍ عالية، وتردّ ملفًّا رُفع بالخطأ
  // — مقطعَ فيديو مثلًا — قبل أن يملأ القرص.
  "documents.max_megabytes": "20",
  // ─── شاشة الصالة ───
  // الخصوصية الافتراضية «الاسم الأول + أول حرف من العائلة»: الشاشة يراها كل من
  // في الصالة، و«أحمد م.» تعرفه الأسرة ولا يعرفه الغير.
  "display.privacy_mode": "first_initial",
  // نطق الاسم صوتيًا عند النداء. المتصفح لا يسمح بالصوت قبل لمسة، فالنطق لا
  // يعمل فعلًا إلا بعد ضغطة «تشغيل صوت النداء» على التلفاز نفسه.
  "display.voice": "true",
  // رسالة الاعتذار عن التأخير — يشغّلها الاستقبال بضغطة من لوحة اليوم،
  // فلا يبقى المرضى متضايقين بلا تفسير.
  "display.delay_notice": "false",
  // بطاقة «جلسات التقويم اليوم» — تُخفى تلقائيًا في يومٍ بلا جلسات تقويم.
  "display.show_ortho": "true",
  // الإعلانات المتناوبة: سطر لكل إعلان بصيغة «العنوان | النص».
  "display.announcements": "",
  "display.tagline": "ابتسامتك تستحق أفضل عناية",
};

export type SettingsMap = Record<SettingKey, string>;

export const ALL_SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

/**
 * ما يُسمح لصفحة عامة أن تقرأه.
 *
 * `/display` و`/book` تُفتحان بلا تسجيل دخول، وتحتاجان اسم المركز وهاتفه وعدد
 * الكراسي. أسعار الصرف وساعات الدوام ليست سرًّا خطيرًا، لكن القائمة تبقى **مسموحًا**
 * لا **ممنوعًا**: مفتاحٌ يُضاف غدًا (نسبة طبيب، رقم حساب) يكون محجوبًا تلقائيًا.
 */
export const PUBLIC_SETTING_KEYS: SettingKey[] = [
  "clinic.name",
  "clinic.lead_doctor",
  "clinic.lead_doctor_title",
  "clinic.lead_doctor_credentials",
  "clinic.phone",
  "clinic.address",
  "clinic.chairs",
];

export function withDefaults(stored: Partial<Record<string, string>>): SettingsMap {
  const result = {} as SettingsMap;
  for (const key of ALL_SETTING_KEYS) {
    const value = stored[key];
    result[key] = value !== undefined && value !== null && value !== "" ? value : SETTING_DEFAULTS[key];
  }
  return result;
}

export function publicSubset(settings: SettingsMap): Partial<SettingsMap> {
  const result: Partial<SettingsMap> = {};
  for (const key of PUBLIC_SETTING_KEYS) result[key] = settings[key];
  return result;
}

/**
 * رقم من الإعدادات مع حدّ أدنى وأعلى.
 *
 * قيمة تالفة في الجدول — حرف، أو صفر كرسي — كانت ستُعطّل اللوحة كلها بقسمة على صفر
 * أو بجدول كراسٍ فارغ. الحدّ يجعل أسوأ إعداد خاطئ **قبيحًا** لا **مُعطِّلًا**.
 */
export function numberSetting(
  settings: SettingsMap,
  key: SettingKey,
  min: number,
  max: number,
): number {
  const parsed = Number(String(settings[key]).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
  const fallback = Number(SETTING_DEFAULTS[key]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function chairCount(settings: SettingsMap): number {
  return Math.round(numberSetting(settings, "clinic.chairs", 1, 20));
}

/**
 * سعر صرف عملة مقابل العملة الأساسية، من الإعدادات.
 *
 * مصدر واحد لقراءة السعر: كان يُقرأ في كل مسار على حدة، فأي تغيير في مفاتيح
 * الأسعار يحتاج تتبّع كل موضع — ومن يفوته موضع يحصل على مكافئ خطأ بصمت. ويعيد
 * `null` للسعر غير الصالح بدل أن يحسب المكافئ صفرًا.
 */
export function rateFromSettings(
  settings: SettingsMap,
  currency: string,
  base: string,
): number | null {
  if (currency === base) return 1;
  const raw = currency === "SAR" ? settings["finance.rate.SAR"] : settings["finance.rate.USD"];
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** حدود التحقق عند الحفظ — لكل مفتاح ما يُقبل فيه. */
export function validateSetting(key: SettingKey, value: string): string | null {
  const trimmed = value.trim();
  if (key === "clinic.name" && (trimmed.length < 3 || trimmed.length > 160)) {
    return "اسم المركز قصير أو طويل أكثر من اللازم.";
  }
  if (key === "clinic.chairs") {
    const chairs = Number(trimmed);
    if (!Number.isInteger(chairs) || chairs < 1 || chairs > 20) return "عدد الكراسي بين 1 و20.";
  }
  if (key === "clinic.day_start" || key === "clinic.day_end") {
    if (!/^\d{2}:\d{2}$/.test(trimmed)) return "الوقت بصيغة 09:00.";
  }
  if (key === "finance.rate.SAR" || key === "finance.rate.USD") {
    const rate = Number(trimmed);
    // سعر صرف صفر أو سالب يجعل كل دفعة بتلك العملة تساوي صفرًا في التقارير بصمت.
    if (!Number.isFinite(rate) || rate <= 0) return "سعر الصرف رقم أكبر من صفر.";
    if (rate > 1_000_000) return "سعر الصرف غير منطقي.";
  }
  if (key === "finance.locked_before") {
    // الفراغ مقبول: هو حالة «لا قفل». وتاريخ بصيغة أخرى يُقفل الدفاتر كلها أو لا
    // يُقفل شيئًا، وكلاهما خطأ صامت.
    if (trimmed && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return "تاريخ القفل بصيغة 2026-08-31 أو اتركه فارغًا.";
    }
  }
  if (key === "lab.default_days") {
    const days = Number(trimmed);
    if (!Number.isInteger(days) || days < 1 || days > 120) return "المهلة بين 1 و120 يومًا.";
  }
  if (key === "recall.lapse_weeks") {
    const weeks = Number(trimmed);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 104) return "المدة بين 1 و104 أسابيع.";
  }
  // ─── شاشة الصالة ───
  if (key === "display.privacy_mode") {
    if (trimmed !== "first_initial" && trimmed !== "first_only") {
      return "طريقة الخصوصية: first_initial أو first_only.";
    }
  }
  if (key === "display.voice" || key === "display.delay_notice" || key === "display.show_ortho") {
    if (trimmed !== "true" && trimmed !== "false") return "القيمة: true أو false.";
  }
  if (key === "display.announcements") {
    // السطر الفارغ مقبول: يعني «استعمل الافتراضي». السطر الموجود لا يُقبل إلا
    // بصيغة «العنوان | النص» — والرسالة تسمّي رقم السطر ليجده المدير فورًا.
    const lines = trimmed.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      const separatorIndex = line.indexOf("|");
      if (separatorIndex <= 0) {
        return `الإعلان رقم ${index + 1} بصيغة «العنوان | النص».`;
      }
      // الفاصل الأول فقط: النص نفسه قد يحتوي «|» ولا يصح قطعه.
      const title = line.slice(0, separatorIndex).trim();
      const body = line.slice(separatorIndex + 1).trim();
      if (!title || !body) {
        return `الإعلان رقم ${index + 1}: العنوان والنص مطلوبان.`;
      }
      if (title.trim().length > 60) return `الإعلان رقم ${index + 1}: العنوان أطول من 60 حرفًا.`;
      if (body.trim().length > 200) return `الإعلان رقم ${index + 1}: النص أطول من 200 حرف.`;
    }
    if (lines.filter((line) => line.trim()).length > 10) return "عشرة إعلانات كحدّ أقصى.";
  }
  if (key === "display.tagline") {
    if (trimmed.length > 120) return "الشعار أطول من 120 حرفًا.";
  }
  if (trimmed.length > 400) return "القيمة طويلة أكثر من اللازم.";
  return null;
}

export interface SettingField {
  key: SettingKey;
  label: string;
  hint?: string;
  kind: "text" | "number" | "time" | "date";
  group: "clinic" | "finance" | "operations";
}

/** ترتيب الحقول في الشاشة — مجموعات قليلة يقرأها غير المبرمج. */
export const SETTING_FIELDS: SettingField[] = [
  { key: "clinic.name", label: "اسم المركز", kind: "text", group: "clinic" },
  { key: "clinic.lead_doctor", label: "الطبيب المسؤول", kind: "text", group: "clinic" },
  { key: "clinic.lead_doctor_title", label: "التخصص", kind: "text", group: "clinic" },
  { key: "clinic.lead_doctor_credentials", label: "المؤهل", hint: "يظهر تحت الاسم في التقارير", kind: "text", group: "clinic" },
  { key: "clinic.phone", label: "هاتف المركز", hint: "يظهر في رسائل واتساب والسندات", kind: "text", group: "clinic" },
  { key: "clinic.address", label: "العنوان", kind: "text", group: "clinic" },

  { key: "finance.base_currency", label: "العملة الأساسية", hint: "كل التقارير تُحسب بها", kind: "text", group: "finance" },
  { key: "finance.rate.SAR", label: "سعر الريال السعودي", hint: "كم ريالًا يمنيًا يساوي ريالًا سعوديًا اليوم", kind: "number", group: "finance" },
  { key: "finance.rate.USD", label: "سعر الدولار", hint: "كم ريالًا يمنيًا يساوي دولارًا اليوم", kind: "number", group: "finance" },
  { key: "finance.locked_before", label: "قفل الدفاتر قبل تاريخ", hint: "لا يُقبل قيد أو تعديل قبل هذا التاريخ. اتركه فارغًا لإلغاء القفل.", kind: "date", group: "finance" },

  { key: "clinic.chairs", label: "عدد الكراسي", hint: "يحكم الحجز والانتظار وشاشة الصالة", kind: "number", group: "operations" },
  { key: "clinic.day_start", label: "بداية الدوام", kind: "time", group: "operations" },
  { key: "clinic.day_end", label: "نهاية الدوام", kind: "time", group: "operations" },
  { key: "lab.default_days", label: "مهلة المختبر الافتراضية (أيام)", kind: "number", group: "operations" },
  { key: "recall.lapse_weeks", label: "مدة اعتبار المريض منقطعًا (أسابيع)", kind: "number", group: "operations" },
  { key: "documents.max_megabytes", label: "أقصى حجم لملف الأشعة (ميغابايت)", kind: "number", group: "operations" },
];

export const GROUP_LABEL: Record<SettingField["group"], string> = {
  clinic: "هوية المركز",
  finance: "المالية وأسعار الصرف",
  operations: "التشغيل",
};

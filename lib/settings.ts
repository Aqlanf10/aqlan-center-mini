import { CLINIC_ZONE_FALLBACK } from "./clinicZone";
import { documentPrefixProblem } from "./document-numbers";
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
  | "finance.rate_max_age_days"
  | "finance.locked_before"
  | "finance.commission_material_rate"
  | "billing.max_discount_percent"
  | "documents.invoice_prefix"
  | "documents.receipt_prefix"
  | "documents.voucher_prefix"
  | "documents.reversal_prefix"
  | "patients.referral_sources"
  | "lab.default_days"
  | "recall.lapse_weeks"
  | "documents.max_megabytes"
  | "workflow.doctor_financial_view"
  | "display.privacy_mode"
  | "display.voice"
  | "display.delay_notice"
  | "display.show_ortho"
  | "display.announcements"
  | "display.tagline"
  | "backup.enabled"
  | "backup.schedule_enabled"
  | "backup.schedule_time"
  | "backup.schedule_timezone"
  | "backup.retention_daily_count"
  | "backup.retention_weekly_count"
  | "backup.destination_railway_volume"
  | "backup.destination_google_drive"
  | "backup.destination_s3"
  | "reminders.auto_enabled"
  | "reminders.auto_template"
  | "reminders.auto_language"
  | "ai.clinical_external"
  /* مُرحَّلة من ثوابت الشيفرة في المرحلة ١أ — لكلٍّ مستهلكٌ فعليّ، وافتراضيُّها
     يساوي الثابت الذي كان مكتوبًا فلا يتغيّر سلوك العيادة يوم النشر. */
  | "ops.late_tolerance_minutes"
  | "ops.wait_warning_minutes"
  | "ops.wait_critical_minutes"
  | "ops.follow_up_lookback_days"
  | "scheduling.max_days_ahead"
  | "inventory.expiry_soon_days"
  | "scheduling.near_capacity_percent"
  | "clinic.shift2_start"
  | "clinic.shift2_end"
  | "scheduling.emergency_reserve_minutes"
  | "scheduling.waiting_list_hold_days"
  | "scheduling.new_patient_daily_limit";

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
  /* (P3-2) بعد كم يومٍ بلا تحديث يُعدّ سعر الصرف قديمًا فتنبّه جاهزية النظام. */
  "finance.rate_max_age_days": "7",
  // فارغ = لا قفل. يُملأ بتاريخ فيصير كل ما قبله مقفلًا لا يُعدَّل.
  "finance.locked_before": "",
  /* خصم إهلاك المواد المقدَّر (نسب التخصصات) من العمولة — قرار المالك،
     والافتراض مغلق فلا يتغيّر رقمٌ قائم. "on" يفعّله بعد تحديد النسب. */
  "finance.commission_material_rate": "off",
  /* (P1-6) أقصى خصمٍ يمنحه غير المدير على سعر الدليل بسببٍ مكتوب. صفرٌ = لا خصم إلا
     بالمدير — الافتراضيّ الآمن حتى يقرّر المالك نسبةً. */
  "billing.max_discount_percent": "0",
  /* (P3-1) بادئات أرقام المستندات المالية — الافتراضي هو ما طُبع منذ اليوم الأول،
     فلا يتغيّر رقمٌ يوم النشر. الترقيم في lib/document-numbers.ts. */
  "documents.invoice_prefix": "INV",
  "documents.receipt_prefix": "R",
  "documents.voucher_prefix": "V",
  "documents.reversal_prefix": "X",
  /* (P3-8ب) قائمة «من أين جاء المريض» في ملفه — مفصولة بفواصل، والعيادة تعدّلها. */
  "patients.referral_sources": "توصية مريض,طبيب أحاله,وسائل التواصل الاجتماعي,لافتة أو مرور,بحث في الإنترنت,أخرى",
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

  // ─── النسخ الاحتياطي ───
  // افتراضيًا مغلق: تفعيل النسخ التلقائي قرارُ مالكٍ واعٍ لا سلوكٌ صامت.
  "backup.enabled": "false",
  "backup.schedule_enabled": "false",
  "backup.schedule_time": "03:00",
  // منطقة العيادة الافتراضية عدن — وتُقرأ من CLINIC_TIME_ZONE إن ضُبطت.
  "backup.schedule_timezone": CLINIC_ZONE_FALLBACK,
  "backup.retention_daily_count": "30",
  "backup.retention_weekly_count": "12",
  "backup.destination_railway_volume": "true",
  "backup.destination_google_drive": "false",
  /* (P0-3) النسخ خارج المنصة إلى تخزين متوافق مع S3 (Cloudflare R2 / Backblaze).
     مغلقٌ افتراضيًّا: التفعيل قرار المالك بعد وضع مفاتيح التخزين والتشفير في البيئة. */
  "backup.destination_s3": "false",
  // ─── التذكير الآلي بواتساب للأعمال (P2-12) ───
  // معطَّل حتى يملك المركز حساب واتساب للأعمال وقالبًا معتمدًا لدى Meta.
  "reminders.auto_enabled": "false",
  "reminders.auto_template": "appointment_reminder",
  "reminders.auto_language": "ar",
  // (P2-11 — قرار المالك) المزوّد الخارجي للمهام الإدارية فقط: النص السريري وتحليل
  // السيفالو لا يخرجان من المركز إلا بتفعيلٍ صريح من المدير.
  "ai.clinical_external": "false",

  // المُرحَّلة — القيم هي الثوابت نفسها التي كانت في lib/arrivals.ts وlib/flow.ts
  // وlib/recall.ts وlib/booking.ts وlib/inventory.ts.
  "ops.late_tolerance_minutes": "15",
  "ops.wait_warning_minutes": "15",
  "ops.wait_critical_minutes": "30",
  "ops.follow_up_lookback_days": "30",
  "scheduling.max_days_ahead": "60",
  "inventory.expiry_soon_days": "30",
  /* عتبة التحذير من امتلاء اليوم — محرّك السعة (المرحلة ٤). */
  "scheduling.near_capacity_percent": "80",
  /* (المرحلة ٤ب) الوردية الثانية — فارغةٌ تعني دوامًا متّصلًا لا وردية ثانية. */
  "clinic.shift2_start": "",
  "clinic.shift2_end": "",
  /* دقائقُ تُحجز للطوارئ في كل وردية. صفرٌ = مُعطَّل، وهو الافتراضيّ عمدًا:
     نشرُ المرحلة ٤ب يجب ألّا يقلّص طاقة الحجز المتاحة اليوم بلا قرارٍ من المالك. */
  "scheduling.emergency_reserve_minutes": "0",
  /* حدّ المرضى الجدد يوميًّا. صفرٌ = بلا حدّ، وهو الافتراضيّ حتى يقرّر المالك. */
  "scheduling.new_patient_daily_limit": "0",
  /* (المرحلة ٥) كم يبقى المنتظِر في القائمة. صفرٌ = بلا انتهاء، وهو الافتراضيّ
     عمدًا: قائمةٌ تُسقط أسماءً وحدها تفعل ذلك صامتةً، والمريض المحذوف لا يعرف. */
  "scheduling.waiting_list_hold_days": "0",
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
  // قائمة مصادر المرضى تظهر في محرّر الملف — تسمياتٌ لا سرّ فيها.
  "patients.referral_sources",
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
  if (
    key === "documents.invoice_prefix" || key === "documents.receipt_prefix"
    || key === "documents.voucher_prefix" || key === "documents.reversal_prefix"
  ) {
    const problem = documentPrefixProblem(trimmed);
    if (problem) return problem;
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
  // ─── النسخ الاحتياطي ───
  if (key === "backup.enabled"
      || key === "backup.schedule_enabled"
      || key === "backup.destination_railway_volume"
      || key === "backup.destination_google_drive"
      || key === "backup.destination_s3") {
    if (trimmed !== "true" && trimmed !== "false") return "القيمة: true أو false.";
  }
  if (key === "reminders.auto_enabled") {
    if (trimmed !== "true" && trimmed !== "false") return "القيمة: true أو false.";
  }
  if (key === "reminders.auto_template") {
    // اسم القالب لدى Meta: حروف لاتينية صغيرة وأرقام وشرطة سفلية.
    if (!/^[a-z0-9_]{1,512}$/.test(trimmed)) return "اسم القالب كما سُجّل لدى Meta: حروف لاتينية صغيرة وأرقام و_ فقط.";
  }
  if (key === "reminders.auto_language") {
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(trimmed)) return "رمز لغة القالب مثل ar أو en_US.";
  }
  if (key === "ai.clinical_external") {
    if (trimmed !== "true" && trimmed !== "false") return "القيمة: true أو false.";
  }
  if (key === "backup.schedule_time") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) return "وقت النسخ بصيغة 03:00.";
  }
  if (key === "backup.schedule_timezone") {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: trimmed });
    } catch {
      return `منطقة زمنية غير معروفة — مثال صحيح: ${CLINIC_ZONE_FALLBACK}.`;
    }
  }
  if (key === "backup.retention_daily_count") {
    const count = Number(trimmed);
    if (!Number.isInteger(count) || count < 1 || count > 365) return "عدد النسخ اليومية بين 1 و365.";
  }
  if (key === "backup.retention_weekly_count") {
    const count = Number(trimmed);
    if (!Number.isInteger(count) || count < 1 || count > 52) return "عدد النسخ الأسبوعية بين 1 و52.";
  }
  if (trimmed.length > 400) return "القيمة طويلة أكثر من اللازم.";
  return null;
}

export interface SettingField {
  key: SettingKey;
  label: string;
  hint?: string;
  kind: "text" | "number" | "time" | "date" | "boolean";
  group: "clinic" | "finance" | "operations" | "backup";
}

/** ترتيب الحقول في الشاشة — مجموعات قليلة يقرأها غير المبرمج. */
export const SETTING_FIELDS: SettingField[] = [
  { key: "clinic.name", label: "اسم المركز", kind: "text", group: "clinic" },
  { key: "clinic.lead_doctor", label: "الطبيب المسؤول", kind: "text", group: "clinic" },
  { key: "clinic.lead_doctor_title", label: "التخصص", kind: "text", group: "clinic" },
  { key: "clinic.lead_doctor_credentials", label: "المؤهل", hint: "يظهر تحت الاسم في التقارير", kind: "text", group: "clinic" },
  { key: "clinic.phone", label: "هاتف المركز", hint: "يظهر في رسائل واتساب والسندات", kind: "text", group: "clinic" },
  { key: "clinic.address", label: "العنوان", kind: "text", group: "clinic" },

  /* (TD-05) دستورية لا تُغيَّر — راجع lib/settings-definitions.ts (systemLocked)
     وlib/money.ts (CLINIC_BASE_CURRENCY). هذا السجل القديم بلا مستهلكٍ تشغيلي. */
  { key: "finance.base_currency", label: "العملة الأساسية", hint: "ثابتة نظام: ريال يمني (YER)", kind: "text", group: "finance" },
  { key: "finance.rate.SAR", label: "سعر الريال السعودي", hint: "كم ريالًا يمنيًا يساوي ريالًا سعوديًا اليوم", kind: "number", group: "finance" },
  { key: "finance.rate.USD", label: "سعر الدولار", hint: "كم ريالًا يمنيًا يساوي دولارًا اليوم", kind: "number", group: "finance" },
  { key: "finance.locked_before", label: "قفل الدفاتر قبل تاريخ", hint: "لا يُقبل قيد أو تعديل قبل هذا التاريخ. اتركه فارغًا لإلغاء القفل.", kind: "date", group: "finance" },
  { key: "finance.commission_material_rate", label: "خصم إهلاك المواد من العمولة", hint: "on = خصم نسب التخصصات المحدَّدة في «نسب إهلاك المواد»؛ off = إبقاء الأرقام كما كانت.", kind: "text", group: "finance" },

  { key: "clinic.chairs", label: "عدد الكراسي", hint: "يحكم الحجز والانتظار وشاشة الصالة", kind: "number", group: "operations" },
  { key: "clinic.day_start", label: "بداية الدوام", kind: "time", group: "operations" },
  { key: "clinic.day_end", label: "نهاية الدوام", kind: "time", group: "operations" },
  { key: "lab.default_days", label: "مهلة المختبر الافتراضية (أيام)", kind: "number", group: "operations" },
  { key: "recall.lapse_weeks", label: "مدة اعتبار المريض منقطعًا (أسابيع)", kind: "number", group: "operations" },
  { key: "documents.max_megabytes", label: "أقصى حجم لملف الأشعة (ميغابايت)", kind: "number", group: "operations" },
  { key: "ai.clinical_external", label: "إرسال الأسئلة السريرية للمزوّد الخارجي", hint: "false (الافتراضي) = المساعد الخارجي للمهام الإدارية فقط، والنص السريري لا يخرج من المركز", kind: "boolean", group: "operations" },

  { key: "backup.enabled", label: "تشغيل نظام النسخ الاحتياطي", hint: "true = النظام يعمل (يدوي ومجدول)؛ false = مغلق كليًا", kind: "boolean", group: "backup" },
  { key: "backup.schedule_enabled", label: "النسخ التلقائي المجدول", hint: "true = يعمل دوريًا في الموعد أدناه عبر المشغّل الخارجي", kind: "boolean", group: "backup" },
  { key: "backup.schedule_time", label: "وقت النسخ التلقائي", hint: "بصيغة 03:00 — بتوقيت المنطقة أدناه", kind: "time", group: "backup" },
  { key: "backup.schedule_timezone", label: "المنطقة الزمنية للجدولة", hint: `مثال: ${CLINIC_ZONE_FALLBACK}`, kind: "text", group: "backup" },
  { key: "backup.retention_daily_count", label: "عدد النسخ اليومية المحفوظة", hint: "30 افتراضيًا — الأقدم يُحذف بعد شهادة أحدث", kind: "number", group: "backup" },
  { key: "backup.retention_weekly_count", label: "عدد النسخ الأسبوعية المحفوظة", hint: "12 افتراضيًا", kind: "number", group: "backup" },
  { key: "backup.destination_railway_volume", label: "الوجهة: قرص Railway الدائم", hint: "الوجهة الأساسية الدائمة — تُبقى مفعّلة", kind: "boolean", group: "backup" },
  { key: "backup.destination_s3", label: "الوجهة: تخزين خارجي (R2 / Backblaze)", hint: "نسخة مشفّرة يوميًّا خارج منصة الاستضافة — تتطلب مفاتيح التخزين ومفتاح التشفير في البيئة", kind: "boolean", group: "backup" },
  { key: "backup.destination_google_drive", label: "الوجهة: Google Drive", hint: "تتطلب اتصال OAuth (مرحلة لاحقة) وتشفير النسخ أولاً", kind: "boolean", group: "backup" },
];

export const GROUP_LABEL: Record<SettingField["group"], string> = {
  clinic: "هوية المركز",
  finance: "المالية وأسعار الصرف",
  operations: "التشغيل",
  backup: "النسخ الاحتياطي",
};

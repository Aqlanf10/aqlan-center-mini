import { describe, expect, it } from "vitest";
import { ALL_SETTING_KEYS, SETTING_DEFAULTS } from "../lib/settings";
import {
  SETTING_DEFINITIONS, definitionsInCategory, searchDefinitions, settingDefinition,
  visibleCategories,
} from "../lib/settings-definitions";
import { validateSettingSet, validateTypedSetting } from "../lib/settings-validate";
import { canManageCategory, roleCan } from "../lib/settings-permissions";
import {
  SETTINGS_AUDIT_ENTITY, SETTINGS_AUDIT_UPDATE, boundValue, secretTransition,
  settingAuditDetails,
} from "../lib/settings-audit";
import { expectedArrivals, LATE_MINUTES } from "../lib/arrivals";
import { DEFAULT_WAIT_THRESHOLDS, waitLevel } from "../lib/flow";
import { expiryState, EXPIRY_SOON_DAYS } from "../lib/inventory";
import { validateBookingRequest, MAX_DAYS_AHEAD } from "../lib/booking";
import type { Appointment } from "../lib/schedule";

/**
 * منصّة الإعدادات — ما يجب أن يصحّ قبل أن يُبنى عليها شيء.
 *
 * القاعدة التي تحكم هذه الاختبارات: **الإعداد الذي لا يغيّر سلوكًا ليس إعدادًا**.
 * فلكل مفتاحٍ مُرحَّل هنا فقرةٌ تُثبت أن تغيير قيمته يغيّر ما يراه المستخدم فعلًا،
 * وأن غيابه يُبقي سلوك الأمس حرفًا بحرف.
 */

describe("سجلّ التعريفات", () => {
  it("كل مفتاحٍ مخزَّن له تعريفٌ مقيَّد بالنوع — لا مفتاح بلا حوكمة", () => {
    const defined = new Set(SETTING_DEFINITIONS.map((d) => d.key));
    const orphans = ALL_SETTING_KEYS.filter((key) => !defined.has(key));
    expect(orphans, `مفاتيح بلا تعريف: ${orphans.join("، ")}`).toEqual([]);
  });

  it("وافتراضيُّ كل تعريفٍ هو الافتراضيُّ المخزَّن نفسه — فالترحيل لا يغيّر شيئًا", () => {
    const drifted = SETTING_DEFINITIONS
      .filter((d) => d.defaultValue !== SETTING_DEFAULTS[d.key])
      .map((d) => d.key);
    expect(drifted, `افتراضيّات متضاربة: ${drifted.join("، ")}`).toEqual([]);
  });

  it("الفئات الفارغة لا تُعرض — لا مفاتيح وهمية لوحداتٍ لم تُبنَ", () => {
    const shown = visibleCategories();
    expect(shown).toContain("reception");
    expect(shown).not.toContain("complaints");
    expect(shown).not.toContain("daily_closing");
    for (const category of shown) {
      expect(definitionsInCategory(category).length).toBeGreaterThan(0);
    }
  });

  it("البحث يجد المفتاح باسمه ووصفه", () => {
    const late = searchDefinitions("late").map((d) => d.key);
    expect(late).toContain("ops.late_tolerance_minutes");
    expect(searchDefinitions("backup").every((d) => d.key.includes("backup"))).toBe(true);
    expect(searchDefinitions("").length).toBe(SETTING_DEFINITIONS.length);
  });
});

describe("التحقّق الخادميّ", () => {
  it("النوع يُفرض: الرقم رقمٌ والمنطقيّ منطقيّ", () => {
    expect(validateTypedSetting("clinic.chairs", "3")).toBeNull();
    expect(validateTypedSetting("clinic.chairs", "ثلاثة")).toContain("عدد الكراسي");
    expect(validateTypedSetting("display.voice", "true")).toBeNull();
    expect(validateTypedSetting("display.voice", "نعم")).toContain("true");
  });

  it("والنطاق يُفرض عند حدّيه", () => {
    expect(validateTypedSetting("clinic.chairs", "1")).toBeNull();
    expect(validateTypedSetting("clinic.chairs", "0")).toContain("أقلّ قيمة");
    expect(validateTypedSetting("clinic.chairs", "51")).toContain("أكبر قيمة");
  });

  it("والقائمة المغلقة ترفض ما ليس فيها", () => {
    expect(validateTypedSetting("finance.base_currency", "YER")).toBeNull();
    expect(validateTypedSetting("finance.base_currency", "EUR")).toContain("العملة الأساسية");
  });

  it("والوقت بصيغته", () => {
    expect(validateTypedSetting("clinic.day_start", "08:30")).toBeNull();
    expect(validateTypedSetting("clinic.day_start", "8:30")).toContain("08:30");
    expect(validateTypedSetting("clinic.day_start", "25:00")).toContain("08:30");
  });

  it("والمفتاح المجهول يُرفض — لا كتابة لما ليس معرَّفًا", () => {
    expect(validateTypedSetting("ops.whatever", "1")).toBe("مفتاح إعداد غير معروف.");
  });

  it("والقيود العابرة للمفاتيح: الحرج أكبر من التحذير", () => {
    const current = { "ops.wait_warning_minutes": "15", "ops.wait_critical_minutes": "30" };
    expect(validateSettingSet({ "ops.wait_critical_minutes": "40" }, current)).toBeNull();
    expect(validateSettingSet({ "ops.wait_critical_minutes": "10" }, current))
      .toContain("أكبر من تحذير الانتظار");
    expect(validateSettingSet({ "clinic.day_end": "07:00" },
      { ...current, "clinic.day_start": "09:00" })).toContain("بعد بدايته");
  });
});

describe("الصلاحيات", () => {
  it("المدير يدير كل فئة", () => {
    expect(canManageCategory("admin", "finance")).toBe(true);
    expect(canManageCategory("admin", "backup")).toBe(true);
    expect(canManageCategory("admin", "staff")).toBe(true);
  });

  it("والاستقبال تقرأ ولا تكتب — ولا تفتح المالية لأنها تفتح العام", () => {
    expect(roleCan("reception", "settings.view")).toBe(true);
    expect(canManageCategory("reception", "general")).toBe(false);
    expect(canManageCategory("reception", "finance")).toBe(false);
  });

  it("والطبيب كذلك، والمجهول لا شيء", () => {
    expect(roleCan("doctor", "settings.view")).toBe(true);
    expect(canManageCategory("doctor", "clinical")).toBe(false);
    expect(roleCan(null, "settings.view")).toBe(false);
    expect(roleCan("hacker", "settings.manage")).toBe(false);
  });

  it("وسجلّ التغييرات للمدير وحده", () => {
    expect(roleCan("admin", "settings.view_history")).toBe(true);
    expect(roleCan("reception", "settings.view_history")).toBe(false);
  });
});

describe("حمولة التدقيق", () => {
  const normal = settingDefinition("ops.late_tolerance_minutes")!;

  it("العادي يحمل قيمته قبل وبعد وسببه", () => {
    const details = settingAuditDetails({ definition: normal, before: "15", after: "20", reason: "زحمة" });
    expect(details["قبل"]).toBe("15");
    expect(details["بعد"]).toBe("20");
    expect(details["السبب"]).toBe("زحمة");
    expect(details["المفتاح"]).toBe("ops.late_tolerance_minutes");
    expect(details["الفئة"]).toBe("reception");
  });

  it("والسرّ لا يحمل قيمةً بحال — الحالة المعنوية وحدها", () => {
    const secret = { ...normal, key: "x.secret" as never, sensitivity: "secret" as const };
    const details = settingAuditDetails({ definition: secret, before: "", after: "hunter2" });
    expect(details["الحالة"]).toBe("CONFIGURED");
    expect(details["قبل"]).toBeUndefined();
    expect(details["بعد"]).toBeUndefined();
    expect(JSON.stringify(details)).not.toContain("hunter2");

    const replaced = settingAuditDetails({ definition: secret, before: "old", after: "new" });
    expect(replaced["الحالة"]).toBe("REPLACED");
    expect(JSON.stringify(replaced)).not.toContain("old");
    expect(JSON.stringify(replaced)).not.toContain("new");

    expect(settingAuditDetails({ definition: secret, before: "old", after: "" })["الحالة"]).toBe("REMOVED");
  });

  it("والانتقالات مسمّاة", () => {
    expect(secretTransition("", "")).toBe("NOT_CONFIGURED");
    expect(secretTransition("", "a")).toBe("CONFIGURED");
    expect(secretTransition("a", "b")).toBe("REPLACED");
    expect(secretTransition("a", "")).toBe("REMOVED");
  });

  it("والقيمة الطويلة تُقصّ ويُقال إنها قُصَّت — لا سجلٌّ بلا حدّ", () => {
    const long = "ط".repeat(900);
    const bounded = boundValue(long);
    expect(bounded.length).toBeLessThan(long.length);
    expect(bounded).toContain("قُصَّ");
  });

  it("والفعل والكيان يميّزان إعدادات المركز عمّا سواها", () => {
    expect(SETTINGS_AUDIT_ENTITY).toBe("clinic_setting");
    expect(SETTINGS_AUDIT_UPDATE).toBe("clinic_settings.update");
    expect(SETTINGS_AUDIT_UPDATE).not.toBe("settings.update");
  });
});

/* ═══ المستهلكون: الإعداد الذي لا يغيّر سلوكًا ليس إعدادًا ═══ */

const appointment = (over: Partial<Appointment>): Appointment => ({
  id: 1, patientId: 1, patientName: "مريض", patientPhone: null,
  scheduledDate: "2026-09-12", scheduledTime: "10:00", durationMinutes: 30,
  appointmentType: null, note: null, status: "booked", reminderSentAt: null,
  doctorId: null, doctorName: null, ...over,
});

describe("المستهلكون يقرأون الإعداد فعلًا", () => {
  it("حدّ التأخّر يغيّر مَن يُعرض متأخّرًا", () => {
    const rows = [appointment({ scheduledTime: "09:40" })];
    expect(expectedArrivals(rows, "10:00")[0].late).toBe(true);        // الافتراضيّ ١٥
    expect(expectedArrivals(rows, "10:00", 30)[0].late).toBe(false);   // رُفع إلى ٣٠
    expect(expectedArrivals(rows, "10:00", 5)[0].late).toBe(true);
  });

  it("وغيابه يُبقي سلوك الأمس", () => {
    const rows = [appointment({ scheduledTime: "09:40" })];
    expect(expectedArrivals(rows, "10:00")).toEqual(expectedArrivals(rows, "10:00", LATE_MINUTES));
  });

  it("وحدُّ فاسدٍ يعود إلى الافتراضي لا يُعطّل الشاشة", () => {
    const rows = [appointment({ scheduledTime: "09:40" })];
    expect(expectedArrivals(rows, "10:00", Number.NaN)[0].late).toBe(true);
    expect(expectedArrivals(rows, "10:00", -5)[0].late).toBe(true);
  });

  it("حدود الانتظار تغيّر لون الصفّ", () => {
    expect(waitLevel(20)).toBe("warning");
    expect(waitLevel(20, { warningMinutes: 25, criticalMinutes: 40 })).toBe("calm");
    expect(waitLevel(45, { warningMinutes: 25, criticalMinutes: 40 })).toBe("critical");
  });

  it("وحدودٌ مقلوبة تعود إلى الافتراضي — ألوانٌ تكذب أسوأ من ألوانٍ قديمة", () => {
    expect(waitLevel(20, { warningMinutes: 40, criticalMinutes: 10 }))
      .toBe(waitLevel(20, DEFAULT_WAIT_THRESHOLDS));
  });

  it("مهلة قرب الانتهاء تغيّر تصنيف الصنف", () => {
    expect(expiryState("2026-10-05", "2026-09-12")).toBe("soon");        // ٢٣ يومًا < ٣٠
    expect(expiryState("2026-10-05", "2026-09-12", 10)).toBe("ok");
    expect(expiryState("2026-10-05", "2026-09-12", 90)).toBe("soon");
    expect(expiryState("2026-10-05", "2026-09-12", 0))
      .toBe(expiryState("2026-10-05", "2026-09-12", EXPIRY_SOON_DAYS));
  });

  it("أقصى مدى للحجز يغيّر ما يُقبل", () => {
    const base = { fullName: "مريض تجربة", phone: "770001122" };
    const today = "2026-09-12";
    expect(validateBookingRequest({ ...base, preferredDate: "2026-10-20" }, today).ok).toBe(true);
    expect(validateBookingRequest({ ...base, preferredDate: "2026-10-20" }, today, 7).ok).toBe(false);
    expect(validateBookingRequest({ ...base, preferredDate: "2026-09-15" }, today, 7).ok).toBe(true);
    // مدًى فاسد يعود إلى الافتراضي لا يمنع كل حجز
    expect(validateBookingRequest({ ...base, preferredDate: "2026-10-20" }, today, 0).ok)
      .toBe(validateBookingRequest({ ...base, preferredDate: "2026-10-20" }, today, MAX_DAYS_AHEAD).ok);
  });
});

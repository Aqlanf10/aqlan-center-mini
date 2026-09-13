import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  searchDefinitions,
  settingDefinition,
  visibleCategories,
} from "../lib/settings-definitions";
import {
  canRestoreHistoryValue,
  formatSettingValue,
  historyActionLabel,
  isDefaultSettingValue,
  settingControlKind,
} from "../lib/settings-ui";

const pageSource = readFileSync(resolve(process.cwd(), "app/settings/page.tsx"), "utf8");
const historySource = readFileSync(resolve(process.cwd(), "app/settings/history/page.tsx"), "utf8");
const routeSource = readFileSync(resolve(process.cwd(), "app/api/settings/route.ts"), "utf8");

describe("Phase 1B — عقد واجهة الإعدادات", () => {
  it("تستمدّ الفئات والبحث من سجل Phase 1A ولا تعرض الفئات الفارغة", () => {
    expect(pageSource).toContain("visibleCategories()");
    expect(pageSource).toContain("searchDefinitions(query)");
    const shown = visibleCategories();
    expect(shown).toContain("capacity"); // عدد الكراسي مستهلك حقيقي اليوم
    expect(shown).not.toContain("complaints");
    expect(shown).not.toContain("daily_closing");
  });

  it("لا تعيد تعريف المفاتيح الستة أو افتراضياتها في الشاشة", () => {
    for (const key of [
      "ops.late_tolerance_minutes",
      "ops.wait_warning_minutes",
      "ops.wait_critical_minutes",
      "ops.follow_up_lookback_days",
      "scheduling.max_days_ahead",
      "inventory.expiry_soon_days",
    ]) expect(pageSource).not.toContain(`\"${key}\"`);
  });

  it("نوع التعريف هو الذي يختار أداة التحرير", () => {
    expect(settingControlKind(settingDefinition("display.voice")!)).toBe("toggle");
    expect(settingControlKind(settingDefinition("clinic.chairs")!)).toBe("number");
    expect(settingControlKind(settingDefinition("finance.base_currency")!)).toBe("select");
    expect(settingControlKind(settingDefinition("clinic.day_start")!)).toBe("time");
  });

  it("يعرض القيمة بصيغة بشرية وحالة افتراضي/مخصص", () => {
    const late = settingDefinition("ops.late_tolerance_minutes")!;
    expect(formatSettingValue(late, "15")).toBe("15 دقيقة");
    expect(isDefaultSettingValue(late, "15")).toBe(true);
    expect(isDefaultSettingValue(late, "20")).toBe(false);
    expect(formatSettingValue(settingDefinition("display.voice")!, "true")).toBe("مفعّل");
  });

  it("المتقاعد وغير الموصول محكومان بالنظام وليسَا زرّين كاذبين", () => {
    expect(settingDefinition("display.announcements")?.systemLocked).toBe(true);
    expect(settingDefinition("backup.destination_google_drive")?.systemLocked).toBe(true);
  });

  it("الحفظ والإعادة يحملان طابع النسخة وواجهة 409 لا تعيد المحاولة صامتة", () => {
    expect(pageSource).toContain("__versions");
    expect(pageSource).toContain("response.status === 409");
    expect(pageSource).toContain("تعارض تعديل");
    expect(routeSource).toContain("source.__versions");
    expect(routeSource).toContain("values, expected, mode: \"reset\"");
  });

  it("السبب والأثر والمقفل تؤخذ من التعريف نفسه", () => {
    expect(pageSource).toContain("editor.definition.requiresReason");
    expect(pageSource).toContain("definition.impact");
    expect(pageSource).toContain("definition.systemLocked");
  });

  it("السجل يستخدم endpoint المخصص ويدعم الاستعادة ككتابة جديدة", () => {
    expect(historySource).toContain("/api/settings/history");
    expect(historySource).toContain("__versions");
    expect(historySource).toContain("استعادة القيمة السابقة");
    expect(historyActionLabel("clinic_settings.reset")).toContain("الافتراضي");
    const late = settingDefinition("ops.late_tolerance_minutes")!;
    expect(canRestoreHistoryValue(late, "15")).toBe(true);
    expect(canRestoreHistoryValue(settingDefinition("display.announcements"), "x")).toBe(false);
  });

  it("لا يوجد محرر مفاتيح عام ولا زر حذف إعداد", () => {
    expect(pageSource).not.toContain("Delete Setting");
    expect(pageSource).not.toContain("حذف إعداد");
    expect(pageSource).not.toContain("allowFinancialDelete");
    expect(pageSource).not.toContain("disableAudit");
  });

  it("البحث الحقيقي ما زال يجد المستهلكات الحالية", () => {
    expect(searchDefinitions("late").map((d) => d.key)).toContain("ops.late_tolerance_minutes");
    expect(searchDefinitions("قرب انتهاء").map((d) => d.key)).toContain("inventory.expiry_soon_days");
  });
});

import type { SettingsMap } from "./settings";
import { numberSetting } from "./settings";

/**
 * خريطة إعدادات النسخ الاحتياطي — من جدول الإعدادات (النظام القائم) إلى
 * تكوين تشغيلي صريح. القرار هنا مركزي حتى لا يعيد كل مستدعٍ تفسير القيم
 * بنفسه، والحدود تُفرض مرة واحدة لا في كل قارئ.
 *
 * الوجهة الدائمة (Railway Volume) هي بيت البناء والتحقق في PR#21 مهما كانت
 * التفضيلات — مفتاحها يحكم احتسابها وجهةً مُستمَدة منها في الـhistory، لا
 * مكانَ وجود الأرشيف. والوجهات الخارجية لا تُحترم تفعيلها إلا لاحقًا بعد
 * اتصالها الفعلي (بوابة OAuth في PR#21B) وتهيئة التشفير (البلوكِر).
 */

export type BackupTriggerType = "manual" | "scheduled";

export interface BackupRunConfig {
  backupEnabled: boolean;
  scheduleEnabled: boolean;
  scheduleTime: string;
  scheduleTimeZone: string;
  retentionDailyCount: number;
  retentionWeeklyCount: number;
  destinations: {
    railwayVolume: boolean;
    googleDrive: boolean;
  };
}

/** المنطقة الزمنية الافتراضية للعيادة — بيئة العيادة أولًا ثم اليمن. */
export function defaultClinicTimeZone(): string {
  return process.env.CLINIC_TIME_ZONE?.trim() || "Asia/Aden";
}

export function backupSettingKey(suffix: string): `backup.${string}` {
  return `backup.${suffix}` as `backup.${string}`;
}

export function resolveBackupRunConfig(settings: SettingsMap): BackupRunConfig {
  return {
    backupEnabled: settings["backup.enabled"] === "true",
    scheduleEnabled: settings["backup.schedule_enabled"] === "true",
    scheduleTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(settings["backup.schedule_time"] ?? "")
      ? settings["backup.schedule_time"]!
      : "03:00",
    scheduleTimeZone: (settings["backup.schedule_timezone"] ?? "").trim() || defaultClinicTimeZone(),
    retentionDailyCount: numberSetting(settings, "backup.retention_daily_count", 1, 365),
    retentionWeeklyCount: numberSetting(settings, "backup.retention_weekly_count", 1, 52),
    destinations: {
      railwayVolume: settings["backup.destination_railway_volume"] !== "false",
      googleDrive: settings["backup.destination_google_drive"] === "true",
    },
  };
}

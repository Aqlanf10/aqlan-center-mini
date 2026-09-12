import type { SettingsMap } from "./settings";
import { numberSetting } from "./settings";
import { resolveClinicZone } from "./clinicZone";

/**
 * خريطة إعدادات النسخ الاحتياطي — من جدول الإعدادات (النظام القائم) إلى
 * تكوين تشغيلي صريح. القرار هنا مركزي حتى لا يعيد كل مستدعٍ تفسير القيم
 * بنفسه، والحدود تُفرض مرة واحدة لا في كل قارئ.
 *
 * الوجهة الدائمة (Railway Volume) هي بيت البناء والتحقق في PR#21 مهما كانت
 * التفضيلات — مفتاحها يحكم احتسابها وجهةً مُستمَدة منها في الـhistory، لا
 * مكانَ وجود الأرشيف. والوجهات الخارجية لا تُحترم تفعيلها إلا لاحقًا بعد
 * اتصالها الفعلي (بوابة OAuth في PR#21B) وتهيئة التشفير (البلوكِر).
 *
 * ### طبقة القرص الدائم (قبل بوابة الهجرة)
 *
 * تفعيل النسخ التلقائي **قبل** اعتماد بوابة الهجرة لا يجوز أن يتطلب كتابةً
 * في قاعدة الإنتاج — فتأتي طبقة الملف الدائم `backup-config.json` (داخل
 * مجلد حالة النسخ): تُكتب من نقطة إدارية حصراً (requireBackupAdminReadOnly)،
 * وتُدمج **فوق** قيم جدول settings كتجاوز قرائي، بصفر INSERT/UPDATE في
 * الإنتاج. القيم هنا قليلة وضيقة الحدود، وتُرفض أي قيمة خارج القائمة
 * البيضاء أو خارج نطاقها — ملف التكوين تكوينٌ لا سكربت.
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
  return resolveClinicZone(process.env.CLINIC_TIME_ZONE);
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

/* ─── طبقة التجاوز الدائمة (backup-config.json) ───────────────────────────── */

/** ملف التجاوز الدائم داخل مجلد حالة النسخ — صفر كتابة في قاعدة الإنتاج. */
export const VOLUME_BACKUP_CONFIG_FILE_NAME = "backup-config.json";

export interface VolumeBackupConfigPatch {
  backupEnabled?: boolean;
  scheduleEnabled?: boolean;
  scheduleTime?: string;
  scheduleTimeZone?: string;
  retentionDailyCount?: number;
  retentionWeeklyCount?: number;
  destinations?: {
    railwayVolume?: boolean;
    googleDrive?: boolean;
  };
}

/**
 * تحقق صارم بقائمة بيضاء: لا مفاتيح مجهولة، لا أنواع ملتبسة (لا نصّ "true" —
 * قيم منطقية حقيقية)، لا وقت خارج HH:MM، لا منطقة زمنية ملفقة، لا عدّ خارج
 * الحدود. الملف تالف ⇒ `{ok:false}` والمستدعي التنفيذي يفشل مغلقًا — لا
 * تخمين ولا تجاهل صامت لتكوينٍ لا يُفهم.
 */
export function parseVolumeBackupConfigPatch(raw: unknown): { ok: true; patch: VolumeBackupConfigPatch } | { ok: false } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false };
  const input = raw as Record<string, unknown>;
  const patch: VolumeBackupConfigPatch = {};

  if ("backupEnabled" in input) {
    if (typeof input.backupEnabled !== "boolean") return { ok: false };
    patch.backupEnabled = input.backupEnabled;
  }
  if ("scheduleEnabled" in input) {
    if (typeof input.scheduleEnabled !== "boolean") return { ok: false };
    patch.scheduleEnabled = input.scheduleEnabled;
  }
  if ("scheduleTime" in input) {
    if (typeof input.scheduleTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.scheduleTime)) {
      return { ok: false };
    }
    patch.scheduleTime = input.scheduleTime;
  }
  if ("scheduleTimeZone" in input) {
    const zone = typeof input.scheduleTimeZone === "string" ? input.scheduleTimeZone.trim() : "";
    if (!zone || zone.length > 64) return { ok: false };
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    } catch {
      return { ok: false };
    }
    patch.scheduleTimeZone = zone;
  }
  if ("retentionDailyCount" in input) {
    const value = input.retentionDailyCount;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 365) return { ok: false };
    patch.retentionDailyCount = value;
  }
  if ("retentionWeeklyCount" in input) {
    const value = input.retentionWeeklyCount;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 52) return { ok: false };
    patch.retentionWeeklyCount = value;
  }
  if ("destinations" in input) {
    const rawDestinations = input.destinations;
    if (typeof rawDestinations !== "object" || rawDestinations === null || Array.isArray(rawDestinations)) {
      return { ok: false };
    }
    const destinations = rawDestinations as Record<string, unknown>;
    patch.destinations = {};
    if ("railwayVolume" in destinations) {
      if (typeof destinations.railwayVolume !== "boolean") return { ok: false };
      patch.destinations.railwayVolume = destinations.railwayVolume;
    }
    if ("googleDrive" in destinations) {
      if (typeof destinations.googleDrive !== "boolean") return { ok: false };
      patch.destinations.googleDrive = destinations.googleDrive;
    }
    if (Object.keys(patch.destinations).length === 0) return { ok: false };
  }

  if (Object.keys(patch).length === 0) return { ok: false };
  return { ok: true, patch };
}

/** دمج التجاوز الدائم فوق التكوين المحلول — آخر كلمة للقرص الدائم. */
export function mergeBackupRunConfig(base: BackupRunConfig, patch: VolumeBackupConfigPatch): BackupRunConfig {
  return {
    backupEnabled: patch.backupEnabled ?? base.backupEnabled,
    scheduleEnabled: patch.scheduleEnabled ?? base.scheduleEnabled,
    scheduleTime: patch.scheduleTime ?? base.scheduleTime,
    scheduleTimeZone: patch.scheduleTimeZone ?? base.scheduleTimeZone,
    retentionDailyCount: patch.retentionDailyCount ?? base.retentionDailyCount,
    retentionWeeklyCount: patch.retentionWeeklyCount ?? base.retentionWeeklyCount,
    destinations: {
      railwayVolume: patch.destinations?.railwayVolume ?? base.destinations.railwayVolume,
      googleDrive: patch.destinations?.googleDrive ?? base.destinations.googleDrive,
    },
  };
}

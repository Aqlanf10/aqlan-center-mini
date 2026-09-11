import path from "node:path";
import { removeFileQuiet } from "./backupVolume";
import { updateBackupHistoryRecord, type BackupHistoryRecord } from "./backupHistory";
import type { RetentionPolicyLike } from "./backupRetentionTypes";

/**
 * الاحتفاظ بالنسخ — حذفٌ بالخلَف لا بالإيماء.
 *
 * القواعد الخمس الصارمة (بترتيبها لا يجري شيء):
 * ١) **الأحدث المُتحقق لا يُحذف أبدًا** — مهما كانت السياسة.
 * ٢) لا يُحذف قديمٌ قبل وجود أحدث مُتحقق منه (القاعدة الأولى تكفي عمليًّا،
 *    وهذه تثبّت المبدأ: الحذف لا يمر إلا بعد شهادة أحدث).
 * ٣) لا يُحذف نسخٌ ما زالت هي آخر شهادة نجاحٍ لوجهة نسخٍ خارجية — فحذفها
 *    يترك الوجهة بلا نسخة صالحة وحيدة قبل أن يتكرر النسخ إليها.
 * ٤) الفاشلة والمبترَة لا تُحتسب في أي جرّ retention — فقط verified.
 * ٥) ملفات .tmp الناقصة تُنظَّف مسارًا مستقلًّا لا ضمن العدّ.
 */

export interface RetentionPolicy {
  dailyCount: number;
  weeklyCount: number;
}

export type { RetentionPolicyLike };

/** أسبوع ISO للتاريخ — "YYYY-Www" لتمثيل أسبوع الاحتفاظ. */
function isoWeekKey(dateIso: string): string {
  const date = new Date(dateIso);
  if (Number.isNaN(date.getTime())) return "";
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7; // الاثنين = 0
  target.setUTCDate(target.getUTCDate() - dayNumber + 3); // خميس الأسبوع
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * اختيار المعرّفات المحذوفة — دالة نقية تُختبر بلا قرص.
 * ترجع محذوفات مرتبة من الأقدم فالأحدث، ولا تحمل أبدًا الأحدث المُتحقق.
 */
export function selectRetentionDeletions(
  records: BackupHistoryRecord[],
  policy: RetentionPolicy,
): string[] {
  const verified = records
    .filter((record) => record.status === "verified" && !record.deletedAt)
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  if (verified.length === 0) return [];

  const keep = new Set<string>();
  // ١) الأحدث المطلق محفوظ.
  keep.add(verified[0].backupId);

  // ٢) ممثِّل الأيام: أحدث نسخة لكل يوم (UTC) — نُبقي أحدث dailyCount يوم.
  const dailySeen = new Set<string>();
  for (const record of verified) {
    const day = record.createdAt.slice(0, 10);
    if (!dailySeen.has(day)) {
      dailySeen.add(day);
      keep.add(record.backupId);
    }
    if (dailySeen.size >= Math.max(1, policy.dailyCount)) break;
  }

  // ٣) ممثِّل الأسابيع: أحدث نسخة لكل أسبوع ISO — نُبقي أحدث weeklyCount أسبوع.
  const weeklySeen = new Set<string>();
  for (const record of verified) {
    const week = isoWeekKey(record.createdAt);
    if (!week) continue;
    if (!weeklySeen.has(week)) {
      weeklySeen.add(week);
      keep.add(record.backupId);
    }
    if (weeklySeen.size >= Math.max(1, policy.weeklyCount)) break;
  }

  // ٤) آخر نجاحٍ لكل وجهة خارجية محفوظ — قاعدة «ما زال يتطلبه مزوّد».
  const lastExternalSuccess = new Map<string, string>();
  for (const record of verified) {
    for (const destination of record.destinations) {
      if (destination.destination === "railway_volume") continue;
      if (destination.status !== "success") continue;
      if (!lastExternalSuccess.has(destination.destination)) {
        lastExternalSuccess.set(destination.destination, record.backupId);
      }
    }
  }
  for (const backupId of lastExternalSuccess.values()) keep.add(backupId);

  // ٥) البقية محذوفات — الأقدم أولًا.
  return verified
    .filter((record) => !keep.has(record.backupId))
    .map((record) => record.backupId)
    .reverse();
}

export interface RetentionRunResult {
  deleted: string[];
  /** أخطاء حذف معقّمة (ملف عالق مثلًا) — لا توقف بقية القائمة. */
  errors: string[];
  cleanedTmpFiles: string[];
}

/**
 * تنفيذ الاحتفاظ على القرص: لكل معرف محذوف — إزالة الأرشيف ثم تعيين
 * deletedAt في السجل (يبقى شهادةً بلا محتوى). ملف .tmp أقدم من يوم يُنظَّف
 * بمعزلٍ عن العدّ. فشلُ حذفٍ لا يمنع البقية ولا يمسّ السجل.
 */
export async function runBackupRetention(
  backupDir: string,
  policy: RetentionPolicy,
  tmpSweepOlderThanMs = 24 * 60 * 60 * 1000,
): Promise<RetentionRunResult> {
  const { readdir, stat } = await import("node:fs/promises");

  const records = await import("./backupHistory").then((module) => module.readBackupHistory(backupDir));
  const deletions = selectRetentionDeletions(records, policy);
  const errors: string[] = [];
  const deleted: string[] = [];

  for (const backupId of deletions) {
    try {
      await removeFileQuiet(path.join(backupDir, backupId));
      await updateBackupHistoryRecord(backupDir, backupId, { deletedAt: new Date().toISOString() });
      deleted.push(backupId);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "فشل حذف أرشيف قديم.");
    }
  }

  // تنظيف .tmp اليتيمة — بقايا تجميعٍ ماتت عمليتها؛ لا يخصّ عدّ الاحتفاظ.
  const cleanedTmpFiles: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(backupDir);
  } catch {
    return { deleted, errors, cleanedTmpFiles };
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(".") || !entry.endsWith(".tmp")) continue;
    try {
      const fileStat = await stat(path.join(backupDir, entry));
      if (now - fileStat.mtimeMs > tmpSweepOlderThanMs) {
        await removeFileQuiet(path.join(backupDir, entry));
        cleanedTmpFiles.push(entry);
      }
    } catch {
      // ملف اختفى بين القارئ والحذف — لا شيء يستوجب الإخفاق.
    }
  }

  return { deleted, errors, cleanedTmpFiles };
}

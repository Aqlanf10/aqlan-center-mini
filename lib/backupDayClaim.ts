import path from "node:path";
import { atomicWriteJson, backupStateDir, isValidBackupArchiveId, readJsonFile } from "./backupVolume";

/**
 * ادعاء دور اليوم المجدول — الذرّية مع القفل لا بعده.
 *
 * ### العلة التي جاءت لإصلاحها
 *
 * كانت علامة اليوم تُكتب **بعد** إرجاع القفل: نافذةٌ بين release والمكتبة
 * تفتح للعملية الثانية أن ترى اليوم غير مكتمل فتبني نسخةً ثانية لنفس اليوم.
 * الإصلاح بنيوي: الادعاء يُكتب **داخل القسم الحرج نفسه** الذي تُبنى فيه
 * النسخة المُتحققة — لا قفل يُرجَع قبل أن يُثبَّت الدور، فلا نافذة أصلًا.
 *
 * ### البروتوكول
 *
 *  * ملف الادعاء: `schedule-days/<YYYY-MM-DD>.json` — تاريخ العيادة المحلي
 *    (لا UTC) لأن الدور بتوقيت العيادة.
 *  * القرار داخل القفل: الملف موجود ⇒ اليوم مُدَّعى ⇒ لا نسخة ثانية مهما
 *    كانت الضربة أو العملية. غائب ⇒ واصل الدورة.
 *  * الكتابة بعد الاكتمال المُتحقَّق داخل القفل: فشل النسخة لا يدّعي شيئًا —
 *    الدور يبقى مستحقًا (فشل اليوم مسموحٌ بإعادة محاولته).
 *  * فشل **كتابة** الادعاء لا يُبتلع: الدورة تُعلن أن إتمام اليوم لم يُسجَّل
 *    دوامًا — والمستدعي لا يُخبر بالنجاح. لا نجاحٌ بلا شهادة دوام.
 */

export const SCHEDULE_DAYS_DIR_NAME = "schedule-days";

/** التاريخ المحلي بصيغة المجلد — لا شيء آخر يُقبل مكوّنَ مسار. */
const CLAIM_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface ScheduleDayClaim {
  date: string;
  backupId: string;
  recordedAt: string;
}

function scheduleDaysDir(backupDir: string): string {
  return path.join(backupStateDir(backupDir), SCHEDULE_DAYS_DIR_NAME);
}

/** مسار ادعاء يومٍ محدد — التاريخ يُفحص من الباب (لا مكوّن مسار من مصدرٍ حر). */
function claimPathFor(backupDir: string, clinicDate: string): string {
  if (!CLAIM_DATE_PATTERN.test(clinicDate)) {
    throw new Error("تاريخ ادعاء الدور بصيغة غير صالحة.");
  }
  return path.join(scheduleDaysDir(backupDir), `${clinicDate}.json`);
}

/** هل يوَمُ اليوم؟ — قراءة الادعاء؛ الغائب يعني اليوم حر. */
export async function readScheduleDayClaim(
  backupDir: string,
  clinicDate: string,
): Promise<ScheduleDayClaim | null> {
  const result = await readJsonFile<ScheduleDayClaim>(claimPathFor(backupDir, clinicDate));
  if (!result.ok) return null;
  const claim = result.data;
  if (claim?.date !== clinicDate || !isValidBackupArchiveId(claim.backupId)) return null;
  return claim;
}

/**
 * أحدث يومٍ مُدَّعى — لنقطة المجدول: إن كان اليوم نفسه مُدَّعى فالدور انتهى.
 * الأسماء بصيغة YYYY-MM-DD فالأقصى معجميًّا هو الأحدث بحكم الصيغة نفسها.
 */
export async function latestScheduleDayClaimDate(backupDir: string): Promise<string | null> {
  const { readdir } = await import("node:fs/promises");
  let entries: string[] = [];
  try {
    entries = await readdir(scheduleDaysDir(backupDir));
  } catch {
    return null;
  }
  const dates = entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .filter((date) => CLAIM_DATE_PATTERN.test(date))
    .sort();
  return dates[dates.length - 1] ?? null;
}

/**
 * تثبيت ادعاء اليوم — يُستدعى **داخل القفل** وبعد نسخةٍ مُتحقَّقة فقط.
 * الكتابة ذرّية (مؤقّت فريد + fsync + rename)، وإن فشلت فالفشل يُعاد
 * للمستدعي صريحًا — لا ابتلاع ولا نجاحٌ بلا تسجيل.
 */
export async function writeScheduleDayClaim(
  backupDir: string,
  clinicDate: string,
  backupId: string,
): Promise<void> {
  if (!CLAIM_DATE_PATTERN.test(clinicDate)) {
    throw new Error("تاريخ ادعاء الدور بصيغة غير صالحة.");
  }
  if (!isValidBackupArchiveId(backupId)) {
    throw new Error("معرّف أرشيف غير صالح لادعاء الدور.");
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(scheduleDaysDir(backupDir), { recursive: true });
  await atomicWriteJson(claimPathFor(backupDir, clinicDate), {
    date: clinicDate,
    backupId,
    recordedAt: new Date().toISOString(),
  } satisfies ScheduleDayClaim);
}

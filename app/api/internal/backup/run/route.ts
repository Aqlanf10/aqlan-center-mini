import { NextResponse } from "next/server";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { resolveBackupDirectory } from "@/lib/backupVolume";
import { getBackupSettingsReadOnly } from "@/lib/backupReadOnly";
import { storageStatus } from "@/lib/files";
import {
  mergeBackupRunConfig,
  resolveBackupRunConfig,
} from "@/lib/backupConfig";
import { readVolumeBackupConfig } from "@/lib/backupRuntimeConfig";
import { isScheduleDueNow } from "@/lib/backupSchedule";
import { latestScheduleDayClaimDate } from "@/lib/backupDayClaim";
import { runBackupCycle } from "@/lib/backupEngine";
import { productionRuntimeActivated } from "@/lib/productionBackup";

export const dynamic = "force-dynamic";

/**
 * نقطة ضرب النسخ التلقائي — للمجدول الخارجي حصرًا (Railway Cron أو غيره).
 *
 * ### لماذا لا مجدول داخلي
 *
 * لا setInterval ولا setTimeout سلطانيًّا: عملية الويب تعاد تشغيلها وتنام،
 * وذاكرتها لا عهد لها بالتاريخ. المجدول الحقيقي خارجي يضرب هذه النقطة
 * بانتظام، والقرار الداخلي هنا: هل حان دورُ اليوم؟
 *
 * ### ادعاء اليوم ذرّيّ مع القفل (لا بعدّه)
 *
 * الدور يُثبَّت **داخل القسم الحرج للقفل نفسه** (scheduleClaim للمحرك):
 * فشلُ نسخةٍ اليوم لا يدّعي شيئًا، ونجاحها يُثبَّت قبل رجوع القفل — فلا
 * نافذة يزحف فيها منافس بين الاكتمال والتسجيل، ولا نسخةً ثانية لنفس اليوم
 * مهما كانت الضربات المتزامنة أو العمليات المتعددة. وفشلُ **كتابة** الادعاء
 * لا يُبتلع أبدًا: لا نجاح يُبلَّغ إن لم يُثبَّت الدور دوامًا (500).
 *
 * ### القراءة حصرًا من القاعدة
 *
 * الإعدادات عبر getBackupSettingsReadOnly — SELECT مباشر بلا ensureSchema.
 * جدول settings غائب أو غير مقروء ⇒ فشل مغلق 503: لا إصلاح مخططٍ ضمن النسخ.
 * والتجاوز الدائم (backup-config.json على القرص) آخر كلمة فوق الإعدادات —
 * تفعيل ما قبل الهجرة صفر-الكتابة.
 *
 * ### الأمان
 *
 *  * سرٌّ مخصص (`INTERNAL_BACKUP_RUN_TOKEN`) يمر في ترويسة Bearer فقط —
 *    لا query ولا جسم GET، ولا يظهر في أي سجل.
 *  * المقارنة بزمنٍ ثابت (بصمتي SHA-256 + timingSafeEqual).
 *  * الحارس الزمني: DATABASE_ENVIRONMENT=production وإشارة Railway معًا —
 *    غير ذلك فشلٌ مغلق.
 *  * الاستجابة حالةٌ معقّمة فقط: لا مسارات، لا أسرار، لا تفاصيل قاعدة.
 */

const INTERNAL_BACKUP_TOKEN_ENV = "INTERNAL_BACKUP_RUN_TOKEN";

const noStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** مقارنة بصمتي السر بزمنٍ ثابت — النتيجة واحدة لكل الفشل بلا تفاصيل. */
function bearerSecretMatches(provided: string, expected: string): boolean {
  const providedHash = Buffer.from(createHash("sha256").update(provided, "utf8").digest("hex"), "hex");
  const expectedHash = Buffer.from(createHash("sha256").update(expected, "utf8").digest("hex"), "hex");
  return providedHash.length === expectedHash.length && timingSafeEqual(providedHash, expectedHash);
}

export async function POST(request: Request) {
  // ١) السر: Bearer فقط، بزمنٍ ثابت، والتكوين الناقص فشلٌ مغلق.
  const expected = process.env[INTERNAL_BACKUP_TOKEN_ENV]?.trim() ?? "";
  if (!expected) return noStore({ ok: false, message: "نقطة النسخ التلقائي غير مهيَّأة." }, 503);

  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (!provided || !bearerSecretMatches(provided, expected)) {
    return noStore({ ok: false, message: "رمز التشغيل غير صحيح." }, 401);
  }

  // ٢) الحارس الزمني — التطوير والاختبار لا ينفّذان نسخًا إنتاجيًّا من هنا.
  if (!productionRuntimeActivated()) {
    return noStore({ ok: false, message: "نقطة النسخ التلقائي غير مفعَّلة في هذه البيئة." }, 503);
  }

  // ٣) وجهة القرص الدائم ودليل المستندات — ناقصٌ أو خارج الجذر ⇒ فشل مغلق.
  const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";
  if (!volumeRoot || !path.isAbsolute(volumeRoot)) {
    return noStore({ ok: false, message: "وجهة النسخ غير مضبوطة." }, 503);
  }
  const documents = await storageStatus();
  if (!documents.ready || !documents.directory) {
    return noStore({ ok: false, message: "تخزين المستندات غير جاهز." }, 503);
  }

  // ٤) الإعدادات قراءة حصرًا: جدول غائب أو خطأ ⇒ فشل مغلق — لا إصلاح مخطط.
  const settingsRead = await getBackupSettingsReadOnly();
  if (!settingsRead.ok) {
    return noStore({ ok: false, message: "إعدادات النسخ غير مقروءة — فشل مغلق." }, 503);
  }

  let backupDir: string;
  try {
    backupDir = resolveBackupDirectory(volumeRoot);
  } catch {
    return noStore({ ok: false, message: "وجهة النسخ غير مضبوطة." }, 503);
  }

  // ٥) التكوين: جدول الإعدادات ثم التجاوز الدائم فوقه (تالف ⇒ فشل مغلق —
  //     ملف تكوين لا يُفهم لا يُتجاهل في نظام يُطلق نسخًا).
  const override = await readVolumeBackupConfig(backupDir);
  if (override.status === "corrupt") {
    return noStore({ ok: false, message: "ملف تكوين النسخ الدائم تالف — يلزم تدخّل يدوي." }, 503);
  }
  const config = mergeBackupRunConfig(
    resolveBackupRunConfig(settingsRead.settings),
    override.status === "present" ? override.patch : {},
  );
  if (!config.backupEnabled) {
    return noStore({ ok: true, ran: false, reason: "backup-disabled" }, 200);
  }
  if (!config.scheduleEnabled) {
    return noStore({ ok: true, ran: false, reason: "schedule-disabled" }, 200);
  }

  // ٦) الاستحقاق: أحدث ادعاء دوام (بتوقيت العيادة) ثم قرار اليوم.
  const lastCompletedDate = await latestScheduleDayClaimDate(backupDir);
  const due = isScheduleDueNow(config, lastCompletedDate);
  if (!due.due) {
    return noStore({ ok: true, ran: false, reason: due.reason }, 200);
  }

  // ٧) الدورة — والادعاء داخل القفل: لا نسخة ثانية لليوم عبر العمليات،
  //    وفشل تثبيت الادعاء يمنع أي بلاغ نجاح.
  const result = await runBackupCycle({
    triggerType: "scheduled",
    volumeRoot,
    documentsDir: documents.directory,
    config,
    scheduleClaim: { date: due.today },
  });

  if (result.ran && result.backup?.status === "verified" && result.scheduleDayClaim === "failed") {
    return noStore({
      ok: false,
      error: "schedule-day-not-recorded",
      message: result.scheduleDayError ?? "تعذّر تثبيت ادعاء دور اليوم — لا بلاغ نجاح.",
    }, 500);
  }

  // ٨) الحالة المعقّمة فقط — أسماء وجهات وحالات، بلا مسارات ولا تفاصيل خام.
  return noStore({
    ok: true,
    ran: result.ran,
    reason: result.reason,
    scheduleDayClaim: result.scheduleDayClaim,
    backup: result.backup
      ? {
          status: result.backup.status,
          triggerType: result.backup.triggerType,
          createdAt: result.backup.createdAt,
          archiveSha256: result.backup.archiveSha256,
          archiveBytes: result.backup.archiveBytes,
          documentCount: result.backup.documentCount,
          message: result.backup.message,
        }
      : undefined,
    replicationStatus: result.replicationStatus,
    destinations: result.destinations?.map((entry) => ({
      destination: entry.destination,
      status: entry.status,
    })),
  }, 200);
}

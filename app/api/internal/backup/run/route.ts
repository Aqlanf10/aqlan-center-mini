import { NextResponse } from "next/server";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { readJsonFile } from "@/lib/backupVolume";
import { backupStateDir, resolveBackupDirectory } from "@/lib/backupVolume";
import { getSettingsSafe } from "@/lib/db";
import { storageStatus } from "@/lib/files";
import { resolveBackupRunConfig } from "@/lib/backupConfig";
import { isScheduleDueNow } from "@/lib/backupSchedule";
import { runBackupCycle } from "@/lib/backupEngine";
import { productionRuntimeActivated } from "@/lib/productionBackup";
import { atomicWriteJson } from "@/lib/backupVolume";

export const dynamic = "force-dynamic";

/**
 * نقطة ضرب النسخ التلقائي — للمجدول الخارجي حصرًا (Railway Cron أو غيره).
 *
 * ### لماذا لا مجدول داخلي
 *
 * لا setInterval ولا setTimeout سلطانيًّا: عملية الويب تعاد تشغيلها وتنام،
 * وذاكرتها لا عهد لها بالتاريخ. المجدول الحقيقي خارجي يضرب هذه النقطة
 * بانتظام، والقرار الداخلي هنا: هل حان دورُ اليوم؟ — واليوم المكتمل
 * يُثبَّت على القرص الدائم (marker) فلا يُنفَّذ دورُ اليوم مرتين مهما ضرب
 * المجدول أو تكرر الطلب.
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

interface ScheduleMarker {
  lastScheduledRunDate?: string;
  lastScheduledRunAt?: string;
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

  // ٤) القرار: التكوين ثم استحقاق اليوم (بتوقيت العيادة) ثم marker الدوام.
  const settings = await getSettingsSafe();
  const config = resolveBackupRunConfig(settings);
  if (!config.backupEnabled) {
    return noStore({ ok: true, ran: false, reason: "backup-disabled" }, 200);
  }
  if (!config.scheduleEnabled) {
    return noStore({ ok: true, ran: false, reason: "schedule-disabled" }, 200);
  }

  let backupDir: string;
  try {
    backupDir = resolveBackupDirectory(volumeRoot);
  } catch {
    return noStore({ ok: false, message: "وجهة النسخ غير مضبوطة." }, 503);
  }
  const marker = await readJsonFile<ScheduleMarker>(
    path.join(backupStateDir(backupDir), "schedule.json"),
  );
  const lastCompletedDate = marker.ok ? marker.data.lastScheduledRunDate ?? null : null;
  const due = isScheduleDueNow(config, lastCompletedDate);
  if (!due.due) {
    return noStore({ ok: true, ran: false, reason: due.reason }, 200);
  }

  // ٥) الدورة — القفل الذرّي داخلها يمنع التكرار عبر العمليات، ووعدُها
  //    المشترك يمنعه داخل العملية. لا marker إلا لنسخةٍ مُتحققة: فشلٌ اليوم
  //    يترك دورَ اليوم مستحقًا لضربة المجدول التالية.
  const result = await runBackupCycle({
    triggerType: "scheduled",
    volumeRoot,
    documentsDir: documents.directory,
    config,
  });

  if (result.ran && result.backup?.status === "verified") {
    await atomicWriteJson(path.join(backupStateDir(backupDir), "schedule.json"), {
      lastScheduledRunDate: due.today,
      lastScheduledRunAt: result.backup.createdAt,
    } satisfies ScheduleMarker).catch(() => {});
  }

  // ٦) الحالة المعقّمة فقط — أسماء وجهات وحالات، بلا مسارات ولا تفاصيل خام.
  return noStore({
    ok: true,
    ran: result.ran,
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

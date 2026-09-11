import { NextResponse } from "next/server";
import path from "node:path";
import { isAdmin } from "@/lib/roles";
import { getBackupSettingsReadOnly, requireBackupAdminReadOnly } from "@/lib/backupReadOnly";
import { storageStatus } from "@/lib/files";
import {
  assertDocumentsDirInsideVolume,
  isValidBackupArchiveId,
  resolveBackupDirectory,
} from "@/lib/backupVolume";
import { mergeBackupRunConfig, resolveBackupRunConfig } from "@/lib/backupConfig";
import { readVolumeBackupConfig } from "@/lib/backupRuntimeConfig";
import { runBackupCycle } from "@/lib/backupEngine";

export const dynamic = "force-dynamic";

/**
 * «نسخ الآن» يدوي قابل للتكرار — للمدير وحده، في أي وقت، لكل يومٍ يأتي.
 *
 * ### لماذا وُجدت نقطة ثانية إلى جانب بوابة التفعيل
 *
 * بوابة `/api/settings/production-backup` تفعيلُ لمرةٍ واحدة برمزٍ يُستنفد
 * بالاكتمال — وهذا عينُ ما يريده أول تفعيل موثَّق. أما المالك الذي أراد
 * نسخةً يدوية غدًا وبعد أسبوع فلهذه النقطة: **نفس** دورة المحرك
 * (triggerType="manual")، **نفس** القفل الذرّي، **نفس** التحقق الكامل،
 * **نفس** ضمانات القراءة-الحصر من القاعدة — بلا رمز لمرة واحدة يمنعها.
 *
 * ### القراءة حصرًا من القاعدة
 *
 * الجلسة: توقيع HMAC ثم SELECT مباشر لصف المستخدم (بلا ensureSchema).
 * الإعدادات: SELECT مباشر — جدول غائب أو غير مقروء ⇒ فشل مغلق 503: لا نسخة
 * ولا إصلاح مخطط. التجاوز الدائم (backup-config.json) تالف ⇒ 503.
 *
 * الاستجابة ملخّص معقّم: id بتسمية المحرك المعتمدة، تاريخ، بصمات، مقاس،
 * حالات الوجهات — لا مسارات مطلقة ولا أسرار ولا محتوى.
 */

const noStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST() {
  const auth = await requireBackupAdminReadOnly();
  if (!auth.ok) {
    // الجلسة الغائبة أو الحساب المُبدَّل رفضٌ مصادقة عادي (401 كما كان) —
    // أما جدول users غير المقروء ففشلٌ مغلق (503): لا جلسة ولا إصلاح ضمني.
    return noStore(
      { message: auth.reason === "users-unreadable" ? "المصادقة غير متاحة الآن — يلزم تدخّل يدوي." : "سجّل الدخول من جديد." },
      auth.reason === "users-unreadable" ? 503 : 401,
    );
  }
  if (!isAdmin(auth.session.role)) {
    return noStore({ message: "نسخ «الآن» اليدوي للمدير وحده." }, 403);
  }

  const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";
  if (!volumeRoot || !path.isAbsolute(volumeRoot)) {
    return noStore({ message: "وجهة النسخ غير مضبوطة." }, 503);
  }
  const documents = await storageStatus();
  if (!documents.ready || !documents.directory) {
    return noStore({ message: "تخزين المستندات غير جاهز." }, 503);
  }
  try {
    assertDocumentsDirInsideVolume(documents.directory, volumeRoot);
  } catch {
    return noStore({ message: "دليل المستندات خارج جذر القرص الدائم." }, 503);
  }
  let backupDir: string;
  try {
    backupDir = resolveBackupDirectory(volumeRoot);
  } catch {
    return noStore({ message: "وجهة النسخ غير مضبوطة." }, 503);
  }

  // الإعدادات قراءة حصرًا — فشل القراءة فشلٌ مغلق لا نسخة ولا إصلاح.
  const settingsRead = await getBackupSettingsReadOnly();
  if (!settingsRead.ok) {
    return noStore({ message: "إعدادات النسخ غير مقروءة — فشل مغلق." }, 503);
  }
  const override = await readVolumeBackupConfig(backupDir);
  if (override.status === "corrupt") {
    return noStore({ message: "ملف تكوين النسخ الدائم تالف — يلزم تدخّل يدوي." }, 503);
  }
  const config = mergeBackupRunConfig(
    resolveBackupRunConfig(settingsRead.settings),
    override.status === "present" ? override.patch : {},
  );
  if (!config.backupEnabled) {
    return noStore({ ok: false, reason: "backup-disabled" }, 409);
  }

  const result = await runBackupCycle({
    triggerType: "manual",
    volumeRoot,
    documentsDir: documents.directory,
    config,
    appCommitSha: process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ?? null,
  });

  if (!result.ran) {
    return noStore({ ok: false, reason: result.reason ?? "not-runnable" }, 409);
  }
  if (result.backup?.status !== "verified") {
    return noStore(
      { ok: false, message: result.backup?.message ?? "فشلت دورة النسخ الاحتياطي." },
      500,
    );
  }

  // المعرف لا يُخترع هنا: هو ما أرجعه المحرك، ويُتأكد من نمطه قبل العرض.
  const backupId = isValidBackupArchiveId(result.backup.backupId) ? result.backup.backupId : null;

  return noStore({
    ok: true,
    backup: {
      status: "verified",
      backupId,
      createdAt: result.backup.createdAt,
      triggerType: result.backup.triggerType,
      archiveSha256: result.backup.archiveSha256,
      archiveBytes: result.backup.archiveBytes,
      databaseSha256: result.backup.databaseSha256,
      documentCount: result.backup.documentCount,
    },
    replicationStatus: result.replicationStatus,
    destinations: result.destinations?.map((entry) => ({
      destination: entry.destination,
      status: entry.status,
      detail: entry.detail,
    })),
  }, 200);
}

export async function GET() {
  return noStore({ message: "نسخ «الآن» أمر POST حصرًا." }, 405);
}

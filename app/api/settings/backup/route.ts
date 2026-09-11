import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/roles";
import { getBackupSettingsReadOnly, requireBackupAdminReadOnly } from "@/lib/backupReadOnly";
import { storageStatus } from "@/lib/files";
import { resolveBackupRunConfig, mergeBackupRunConfig, type BackupRunConfig } from "@/lib/backupConfig";
import { readVolumeBackupConfig } from "@/lib/backupRuntimeConfig";
import { destinationProviders } from "@/lib/backupDestinations";
import { nextScheduledRunIso } from "@/lib/backupSchedule";
import { readBackupHistory } from "@/lib/backupHistory";
import { backupStateDir, resolveBackupDirectory } from "@/lib/backupVolume";
import path from "node:path";
import { readProductionBackupActivationState } from "@/lib/productionBackup";

export const dynamic = "force-dynamic";

/**
 * حالة نظام النسخ الاحتياطي للمدير — التكوين الحيّ وآخر المحاولات والوجهات.
 *
 * **قراءة حصرًا من كل شيء**: الجلسة عبر requireBackupAdminReadOnly (توقيع
 * HMAC + SELECT مباشر — بلا ensureSchema)، والإعدادات عبر SELECT مباشر
 * (getBackupSettingsReadOnly في أعلى كل مسار تنفيذي — هنا إن لم تُقرأ فالحالة
 * تعرض settingsReadable=false بدل أن تُنجّم قيمًا)، والتجاوز الدائم ملفٌّ
 * يُقرأ لا يُكتب من هنا. ما يخرج: قيم الإعدادات وحالات النسخ (بصمات ومقاسات
 * وتواريخ وحالات وجهات) وحالة بوابة التفعيل. ما لا يخرج أبدًا: مسارات
 * مطلقة، محتوى أرشيف، رموز، أسرار.
 */

const noStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET() {
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
    return noStore({ message: "حالة النسخ الاحتياطي للمدير وحده." }, 403);
  }

  // الإعدادات قراءة مباشرة بلا ensureSchema: إن فشلت تبقى الشاشة صادقة —
  // تصرح أن الإعدادات غير مقروءة وتُكمل بالافتراضيات + التجاوز الدائم،
  // أما المسارات التنفيذية فتفشل مغلقًا عندها.
  const settingsRead = await getBackupSettingsReadOnly();
  const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";

  let backupDir: string | null = null;
  let history: Awaited<ReturnType<typeof readBackupHistory>> = [];
  let overrideRead: Awaited<ReturnType<typeof readVolumeBackupConfig>> = { status: "absent" };
  if (volumeRoot) {
    try {
      backupDir = resolveBackupDirectory(volumeRoot);
      history = await readBackupHistory(backupDir);
      overrideRead = await readVolumeBackupConfig(backupDir);
    } catch {
      backupDir = null;
    }
  }

  const config = mergeBackupRunConfig(
    resolveBackupRunConfig(settingsRead.ok ? settingsRead.settings : ({} as Parameters<typeof resolveBackupRunConfig>[0])),
    overrideRead.status === "present" ? overrideRead.patch : {},
  );

  const verifiedRecords = history
    .filter((record) => record.status === "verified" && !record.deletedAt)
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  const lastAttempt = history.slice().sort((first, second) => second.createdAt.localeCompare(first.createdAt))[0] ?? null;
  const lastSuccess = verifiedRecords[0] ?? null;
  const lastFailure = history
    .filter((record) => record.status === "failed")
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt))[0] ?? null;

  const documents = await storageStatus();
  const destinations = destinationProviders().map((provider) => {
    const connection = provider.connectionStatus({ config });
    const lastResult = lastAttempt?.destinations.find((entry) => entry.destination === provider.type) ?? null;
    return {
      destination: provider.type,
      label: provider.label,
      connectionStatus: connection.status,
      detail: connection.detail,
      lastAttemptStatus: lastResult?.status ?? null,
      providerFileId: lastResult?.providerFileId ?? null,
    };
  });

  const activation = volumeRoot ? await readProductionBackupActivationState(volumeRoot) : null;

  return noStore({
    config: {
      backupEnabled: config.backupEnabled,
      scheduleEnabled: config.scheduleEnabled,
      scheduleTime: config.scheduleTime,
      scheduleTimeZone: config.scheduleTimeZone,
      retentionDailyCount: config.retentionDailyCount,
      retentionWeeklyCount: config.retentionWeeklyCount,
      destinations: {
        railwayVolume: config.destinations.railwayVolume,
        googleDrive: config.destinations.googleDrive,
        localAgent: "future" as const,
      },
    },
    configSource: {
      settingsReadable: settingsRead.ok,
      volumeOverride: overrideRead.status === "present" ? "present" : overrideRead.status === "corrupt" ? "corrupt" : "absent",
    },
    status: {
      lastAttempt: lastAttempt
        ? { backupId: lastAttempt.backupId, createdAt: lastAttempt.createdAt, status: lastAttempt.status }
        : null,
      lastSuccess: lastSuccess
        ? {
            backupId: lastSuccess.backupId,
            createdAt: lastSuccess.createdAt,
            archiveSha256: lastSuccess.archiveSha256,
            archiveBytes: lastSuccess.archiveBytes,
            documentCount: lastSuccess.documentCount,
            replicationStatus: lastSuccess.replicationStatus,
          }
        : null,
      lastFailure: lastFailure
        ? { backupId: lastFailure.backupId, createdAt: lastFailure.createdAt }
        : null,
      nextScheduledRun: nextScheduledRunIso(config),
      documentsReady: documents.ready,
      storageConfigured: Boolean(documents.directory) && Boolean(volumeRoot),
    },
    activation: activation
      ? {
          completedAt: activation.createdAt,
          filename: activation.filename,
          sha256: activation.sha256,
          bytes: activation.bytes,
          documents: activation.documents,
        }
      : null,
    destinations,
    history: verifiedRecords.slice(0, 20).map((record) => ({
      backupId: record.backupId,
      createdAt: record.createdAt,
      triggerType: record.triggerType,
      archiveSha256: record.archiveSha256,
      archiveBytes: record.archiveBytes,
      documentCount: record.documentCount,
      replicationStatus: record.replicationStatus,
    })),
  }, 200);
}

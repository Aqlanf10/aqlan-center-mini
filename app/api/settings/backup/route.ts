import { NextResponse } from "next/server";
import { getSettingsSafe } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { storageStatus } from "@/lib/files";
import { resolveBackupRunConfig } from "@/lib/backupConfig";
import { destinationProviders } from "@/lib/backupDestinations";
import { nextScheduledRunIso } from "@/lib/backupSchedule";
import { newestVerifiedRecord, readBackupHistory } from "@/lib/backupHistory";
import { backupStateDir, readJsonFile } from "@/lib/backupVolume";
import path from "node:path";
import { readProductionBackupActivationState } from "@/lib/productionBackup";

export const dynamic = "force-dynamic";

/**
 * حالة نظام النسخ الاحتياطي للمدير — التكوين الحيّ وآخر المحاولات والوجهات.
 *
 * ما يخرج من هنا: قيم الإعدادات وحالات النسخ (بصمات ومقاسات وتواريخ وحالات
 * وجهات) وحالة بوابة التفعيل. ما لا يخرج أبدًا: مسارات مطلقة، محتوى أرشيف،
 * رموز، أسرار — الشاشة تجيب «هل النسخ سليم ومتى؟» لا «أين تسكن الملفات؟».
 */

const noStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

interface ScheduleMarker {
  lastScheduledRunDate?: string;
  lastScheduledRunAt?: string;
}

export async function GET() {
  const session = await requireSession();
  if (!session) return noStore({ message: "سجّل الدخول من جديد." }, 401);
  if (!isAdmin(session.role)) {
    return noStore({ message: "حالة النسخ الاحتياطي للمدير وحده." }, 403);
  }

  const settings = await getSettingsSafe();
  const config = resolveBackupRunConfig(settings);
  const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";

  let history: Awaited<ReturnType<typeof readBackupHistory>> = [];
  let scheduleMarker: ScheduleMarker = {};
  if (volumeRoot) {
    try {
      const { resolveBackupDirectory } = await import("@/lib/backupVolume");
      const backupDir = resolveBackupDirectory(volumeRoot);
      history = await readBackupHistory(backupDir);
      const marker = await readJsonFile<ScheduleMarker>(
        path.join(backupStateDir(backupDir), "schedule.json"),
      );
      if (marker.ok) scheduleMarker = marker.data;
    } catch {
      // بلا قرص دائم مضبوط تبقى الحالة فارغة — لا رسالة مسارات.
    }
  }

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
      lastScheduledRunDate: scheduleMarker.lastScheduledRunDate ?? null,
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

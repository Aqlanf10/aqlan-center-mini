import path from "node:path";
import { mergeBackupRunConfig, resolveBackupRunConfig } from "./backupConfig";
import { newestVerifiedRecord, readBackupHistory, type BackupHistoryRecord } from "./backupHistory";
import { readVolumeBackupConfig } from "./backupRuntimeConfig";
import { resolveBackupDirectory } from "./backupVolume";
import { readRestoreDrillState, type RestoreDrillState } from "./restore/admin";
import type { SettingKey } from "./settings";

export interface BackupAuditEvidence {
  lastCompletedExportAt: string | null;
  startedDownloadCount: number;
}

export interface BackupReadinessCheckResult {
  id: "backup_system";
  category: "security";
  title: string;
  description: string;
  status: "pass" | "warn" | "fail";
  actionHref: string;
  actionLabel: string;
}

const BACKUP_FRESH_MAX_DAYS = 7;
const DAY_MS = 86_400_000;

export async function queryBackupAuditEvidenceWith(
  q: { query: <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: R[] }> },
): Promise<BackupAuditEvidence> {
  const { rows } = await q.query<{
    last_completed_at: Date | string | null;
    started_downloads: number | string;
  }>(
    `SELECT
       MAX(created_at) FILTER (WHERE action = 'backup.complete') AS last_completed_at,
       COUNT(*) FILTER (WHERE action IN ('backup.download', 'backup.full_download'))::int AS started_downloads
     FROM audit_log
     WHERE action IN ('backup.complete', 'backup.download', 'backup.full_download')`,
  );
  const rawCompleted = rows[0]?.last_completed_at ?? null;
  const lastCompletedExportAt = rawCompleted instanceof Date
    ? rawCompleted.toISOString()
    : typeof rawCompleted === "string" && rawCompleted.trim() !== ""
      ? rawCompleted
      : null;
  return {
    lastCompletedExportAt,
    startedDownloadCount: Number(rows[0]?.started_downloads ?? 0),
  };
}

function ageDaysSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / DAY_MS));
}

export async function evaluateBackupReadinessCheck(input: {
  settings: Record<SettingKey, string>;
  auditEvidence: BackupAuditEvidence;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<BackupReadinessCheckResult> {
  const env = input.env ?? process.env;
  const nowMs = input.nowMs ?? Date.now();
  const volumeRoot = env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";

  let hasVolume = false;
  let lastVerified: BackupHistoryRecord | null = null;
  let lastRestoreDrill: RestoreDrillState | null = null;
  let overridePatch: Parameters<typeof mergeBackupRunConfig>[1] = {};

  if (volumeRoot && path.isAbsolute(volumeRoot)) {
    try {
      const backupDir = resolveBackupDirectory(volumeRoot);
      hasVolume = true;
      const [history, override, drill] = await Promise.all([
        readBackupHistory(backupDir),
        readVolumeBackupConfig(backupDir),
        readRestoreDrillState(backupDir),
      ]);
      lastVerified = newestVerifiedRecord(history);
      lastRestoreDrill = drill;
      if (override.status === "present") {
        overridePatch = override.patch;
      }
    } catch {
      hasVolume = false;
    }
  }

  const config = mergeBackupRunConfig(
    resolveBackupRunConfig(input.settings),
    overridePatch,
  );

  const verifiedArchiveAgeDays = ageDaysSince(lastVerified?.createdAt ?? null, nowMs);
  const completedExportAgeDays = ageDaysSince(input.auditEvidence.lastCompletedExportAt, nowMs);

  const hasFreshVerifiedArchive = verifiedArchiveAgeDays !== null && verifiedArchiveAgeDays <= BACKUP_FRESH_MAX_DAYS;
  const hasFreshCompletedExport = completedExportAgeDays !== null && completedExportAgeDays <= BACKUP_FRESH_MAX_DAYS;

  const hasExternalCopy = Boolean(
    lastVerified?.destinations?.some(
      (entry) => entry.destination !== "railway_volume" && entry.status === "success",
    ),
  );

  const hasPassedRestoreDrill = Boolean(
    lastRestoreDrill
    && lastRestoreDrill.status === "ready"
    && lastRestoreDrill.readyForCutover === true,
  );

  // S22 / R53: Unknown or unverified backup state is NEVER reported as unconditional pass.
  if (hasFreshVerifiedArchive && hasExternalCopy && hasPassedRestoreDrill) {
    return {
      id: "backup_system",
      category: "security",
      title: "النسخ الاحتياطي والاستعادة المتحققة",
      description: `آخر أرشيف متحقق منذ ${verifiedArchiveAgeDays} يومًا مع نسخة خارجية مكتملة وتمرين استعادة ناجح (${lastRestoreDrill!.targetEnvironment}).`,
      status: "pass",
      actionHref: "/settings/backup",
      actionLabel: "إدارة النسخ والاستعادة",
    };
  }

  const parts: string[] = [];
  if (config.backupEnabled && hasVolume) {
    parts.push("محرك النسخ الدائم مفعّل");
  } else {
    parts.push("أدوات التصدير اليدوي متاحة بينما النسخ الدائم المجدول غير مفعّل");
  }

  if (lastVerified && verifiedArchiveAgeDays !== null) {
    parts.push(
      hasFreshVerifiedArchive
        ? `آخر أرشيف متحقق منذ ${verifiedArchiveAgeDays} يومًا`
        : `آخر أرشيف متحقق قديم منذ ${verifiedArchiveAgeDays} يومًا (الحد ${BACKUP_FRESH_MAX_DAYS} أيام)`,
    );
  } else if (completedExportAgeDays !== null) {
    parts.push(
      hasFreshCompletedExport
        ? `آخر تصدير كامل مكتمل منذ ${completedExportAgeDays} يومًا (بلا شهادة أرشيف دائم)`
        : `آخر تصدير كامل قديم منذ ${completedExportAgeDays} يومًا`,
    );
  } else if (input.auditEvidence.startedDownloadCount > 0) {
    parts.push("سُجّل بدء تنزيل يدوي دون شهادة اكتمال أرشيف متحقق");
  } else {
    parts.push("لم يُسجّل أي أرشيف متحقق أو تصدير مكتمل بعد");
  }

  parts.push(hasExternalCopy ? "النسخة الخارجية متحققة" : "النسخة الخارجية غير مثبتة");
  parts.push(hasPassedRestoreDrill ? "تمرين الاستعادة ناجح" : "تمرين الاستعادة لم يُثبت بعد");

  return {
    id: "backup_system",
    category: "security",
    title: "النسخ الاحتياطي والاستعادة المتحققة",
    description: `${parts.join(" · ")}.`,
    status: "warn",
    actionHref: "/settings/backup",
    actionLabel: "مراجعة النسخ والاستعادة",
  };
}

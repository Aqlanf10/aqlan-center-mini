import path from "node:path";
import { getBackupSettingsReadOnly } from "./backupReadOnly";
import { storageStatus } from "./files";
import { assertDocumentsDirInsideVolume, isValidBackupArchiveId, resolveBackupDirectory } from "./backupVolume";
import { mergeBackupRunConfig, resolveBackupRunConfig } from "./backupConfig";
import { readVolumeBackupConfig } from "./backupRuntimeConfig";
import { runBackupCycle } from "./backupEngine";
import { productionBackupBlocksWithClient } from "./productionBackup";
import type { Queryable } from "./db";

/**
 * «نسخ الآن» — دورة المحرك اليدوية بشروطها كلها، مستخرجةً لتُستعمل من مسارين:
 * زر «نسخ الآن» في الإعدادات، وإعادة الضبط التي لا تمسح شيئًا قبل نسخةٍ متحقَّقٍ منها.
 *
 * كل شرطٍ ناقص فشلٌ مغلق برسالة عربية ورمز حالة؛ والنجاح نسخةٌ **متحقَّق منها**
 * (status = verified) لا مجرد ملفٍ كُتب.
 */
export type ManualBackupResult =
  | {
    ok: true;
    backup: {
      status: "verified";
      backupId: string | null;
      createdAt: string;
      triggerType: string;
      archiveSha256: string | undefined;
      archiveBytes: number | undefined;
      databaseSha256: string | undefined;
      documentCount: number | undefined;
    };
    replicationStatus: unknown;
    destinations: { destination: string; status: string; detail: string | undefined }[] | undefined;
  }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * `client` (اختياري): اتصالٌ تُقرأ منه اللقطة بدل اتصالٍ جديد من المجمع — تستعمله
 * إعادة الضبط لتقرأ النسخةُ على اتصالٍ محجوزٍ قبل تجميد الكتابة.
 */
export async function runVerifiedManualBackup(options: { client?: Queryable } = {}): Promise<ManualBackupResult> {
  const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";
  if (!volumeRoot || !path.isAbsolute(volumeRoot)) {
    return { ok: false, status: 503, body: { message: "وجهة النسخ غير مضبوطة." } };
  }
  const documents = await storageStatus();
  if (!documents.ready || !documents.directory) {
    return { ok: false, status: 503, body: { message: "تخزين المستندات غير جاهز." } };
  }
  try {
    assertDocumentsDirInsideVolume(documents.directory, volumeRoot);
  } catch {
    return { ok: false, status: 503, body: { message: "دليل المستندات خارج جذر القرص الدائم." } };
  }
  let backupDir: string;
  try {
    backupDir = resolveBackupDirectory(volumeRoot);
  } catch {
    return { ok: false, status: 503, body: { message: "وجهة النسخ غير مضبوطة." } };
  }

  // الإعدادات قراءة حصرًا — فشل القراءة فشلٌ مغلق لا نسخة ولا إصلاح.
  const settingsRead = await getBackupSettingsReadOnly();
  if (!settingsRead.ok) {
    return { ok: false, status: 503, body: { message: "إعدادات النسخ غير مقروءة — فشل مغلق." } };
  }
  const override = await readVolumeBackupConfig(backupDir);
  if (override.status === "corrupt") {
    return { ok: false, status: 503, body: { message: "ملف تكوين النسخ الدائم تالف — يلزم تدخّل يدوي." } };
  }
  const config = mergeBackupRunConfig(
    resolveBackupRunConfig(settingsRead.settings),
    override.status === "present" ? override.patch : {},
  );
  if (!config.backupEnabled) {
    return { ok: false, status: 409, body: { ok: false, reason: "backup-disabled" } };
  }

  const appCommitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ?? null;
  const documentsDir = documents.directory;
  const client = options.client;
  const result = await runBackupCycle({
    triggerType: "manual",
    volumeRoot,
    documentsDir,
    config,
    appCommitSha,
    ...(client ? { blocks: () => productionBackupBlocksWithClient(client, { appCommitSha, documentsDir }) } : {}),
  });

  if (!result.ran) {
    return { ok: false, status: 409, body: { ok: false, reason: result.reason ?? "not-runnable" } };
  }
  if (result.backup?.status !== "verified") {
    return { ok: false, status: 500, body: { ok: false, message: result.backup?.message ?? "فشلت دورة النسخ الاحتياطي." } };
  }

  // المعرف لا يُخترع هنا: هو ما أرجعه المحرك، ويُتأكد من نمطه قبل العرض.
  const backupId = isValidBackupArchiveId(result.backup.backupId) ? result.backup.backupId : null;
  return {
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
  };
}

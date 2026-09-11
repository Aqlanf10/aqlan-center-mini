import { rename } from "node:fs/promises";
import path from "node:path";
import { sanitizeErrorMessage } from "./redact";
import {
  acquireBackupLock,
  assertDocumentsDirInsideVolume,
  backupStateDir,
  productionBackupFilename,
  releaseBackupLock,
  resolveBackupDirectory,
  verifyBackupArchiveFile,
  writeArchiveTmpWithFsync,
} from "./backupVolume";
import {
  destinationProviders,
  replicationStatusOf,
  type BackupDestinationProvider,
  type DestinationResult,
  type VerifiedArchiveHandle,
} from "./backupDestinations";
import type { BackupRunConfig, BackupTriggerType } from "./backupConfig";
import {
  readBackupHistory,
  upsertBackupHistoryRecord,
  updateBackupHistoryRecord,
  type BackupHistoryRecord,
} from "./backupHistory";
import { runBackupRetention } from "./backupRetention";
import { productionBackupArchiveBlocks } from "./productionBackup";

/**
 * محرّك النسخ الاحتياطي — دورة واحدة: بناء، تحقق، سجل، نسخٌ للوجهات، احتفاظ.
 *
 * ### ترتيب الدورة الصارم
 *
 * ١) التكوين: النسخ مفعَّل، والوجهات داخل الجذر الدائم.
 * ٢) القفل الذرّي المشترك — القفل نفسه الذي تحرسه بوابة التفعيل، فلا يدخل
 *    دورٌ يدوي ودورٌ مجدول معًا ولو من عمليتين مختلفتين.
 * ٣) البناء المؤقت + fsync داخل مجلد النسخ نفسه (لا /tmp نهائيًّا).
 * ٤) التحقق الكامل — فشلٌ هنا يعني: لا اسم نهائي، وسجلُ محاولةٍ فاشلة معقّم
 *    (الفاشلة لا تُحتسب في الاحتفاظ ولا تُعدّ نسخةً صالحة).
 * ٥) الاسم النهائي ذرّيًّا ⇒ سجل verified ⇒ نسخٌ للوجهات (فشلُ وجهةٍ ثانوية
 *    لا يمسّ الأصل) ⇒ تحديث السجل بنتائج الوجهات ⇒ retention.
 *
 * ### الوجهات والنتيجة الكلية
 *
 * `backup_status=verified` مع `replication_status=partial` هي الحالة التي
 * تحفظ فيها الوجهةُ الثانوية فشلَها بلا أن يُقتل الأرشيف الصالح — وإعادة
 * النسخ للوجهة الراسبة وحدها تمر على الأرشيف نفسه بلا بناءٍ ثانٍ.
 */

export interface BackupCycleInput {
  triggerType: BackupTriggerType;
  volumeRoot: string;
  documentsDir: string;
  config: BackupRunConfig;
  /** حقن الاختبار؛ الإنتاج: مولّد القاعدة بجلسته READ ONLY. */
  blocks?: () => AsyncGenerator<Uint8Array>;
  /** حقن مزوّدي الوجهات للاختبار؛ الإنتاج: السجل القياسي. */
  providers?: BackupDestinationProvider[];
  appCommitSha?: string | null;
  pgVersion?: string | null;
  log?: (message: string) => void;
  now?: Date;
}

export interface BackupCycleSummary {
  backupId: string;
  createdAt: string;
  triggerType: BackupTriggerType;
  status: "verified" | "failed";
  archiveSha256?: string;
  archiveBytes?: number;
  databaseSha256?: string;
  documentCount?: number;
  /** رسالة معقّمة للفشل فقط — لا مسارات ولا أسرار. */
  message?: string;
}

export interface BackupCycleResult {
  ran: boolean;
  reason?: "backup-disabled" | "in-progress" | "misconfigured";
  backup?: BackupCycleSummary;
  replicationStatus?: "complete" | "partial" | "none";
  destinations?: DestinationResult[];
}

/** الوعد المشترك داخل العملية: دوران متزامنان ⇒ دورةٌ واحدة بلا نسخة ثانية. */
let engineInFlight: Promise<BackupCycleResult> | null = null;

export async function runBackupCycle(input: BackupCycleInput): Promise<BackupCycleResult> {
  if (engineInFlight) return engineInFlight;
  engineInFlight = executeBackupCycle(input).finally(() => {
    engineInFlight = null;
  });
  return engineInFlight;
}

async function executeBackupCycle(input: BackupCycleInput): Promise<BackupCycleResult> {
  const log = input.log ?? ((message: string) => console.warn(message));

  if (!input.config.backupEnabled) {
    return { ran: false, reason: "backup-disabled" };
  }

  try {
    let backupDir: string;
    try {
      backupDir = resolveBackupDirectory(input.volumeRoot);
      assertDocumentsDirInsideVolume(input.documentsDir, input.volumeRoot);
    } catch {
      return { ran: false, reason: "misconfigured" };
    }
    const { mkdir } = await import("node:fs/promises");
    await mkdir(backupDir, { recursive: true });
    await mkdir(backupStateDir(backupDir), { recursive: true });

    const lock = await acquireBackupLock(backupStateDir(backupDir), "backup.lock");
    if (lock === "in-progress") {
      return { ran: false, reason: "in-progress" };
    }

    try {
      return await runLockedCycle(input, backupDir, log);
    } finally {
      await releaseBackupLock(lock);
    }
  } catch (error) {
    const safe = sanitizeErrorMessage(error, "فشلت دورة النسخ الاحتياطي بخطأ غير متوقع.");
    log(`[backup-engine] failed reason=${safe}`);
    return {
      ran: true,
      backup: {
        backupId: "",
        createdAt: new Date().toISOString(),
        triggerType: input.triggerType,
        status: "failed",
        message: safe,
      },
      replicationStatus: "none",
      destinations: [],
    };
  }
}

async function runLockedCycle(
  input: BackupCycleInput,
  backupDir: string,
  log: (message: string) => void,
): Promise<BackupCycleResult> {
  const now = input.now ?? new Date();
  const filename = productionBackupFilename(now, input.appCommitSha);
  log(`[backup-engine] started trigger=${input.triggerType}`);

  // البناء المؤقت + التحقق — الرسوب هنا يترك أثرَ محاولةٍ فاشلة في السجل فقط.
  let verified: Awaited<ReturnType<typeof verifyBackupArchiveFile>>;
  try {
    const blocks = input.blocks ?? (() => productionBackupArchiveBlocks({
      appCommitSha: input.appCommitSha,
      pgVersion: input.pgVersion,
    }));
    const tmpPath = await writeArchiveTmp(backupDir, filename, blocks);
    try {
      verified = await verifyBackupArchiveFile(tmpPath, input.documentsDir);
    } catch (error) {
      const { removeFileQuiet } = await import("./backupVolume");
      await removeFileQuiet(tmpPath);
      throw error;
    }
    await rename(tmpPath, path.join(backupDir, filename));
  } catch (error) {
    const safe = sanitizeErrorMessage(error, "فشل بناء أرشيف النسخة أو التحقق منه.");
    log(`[backup-engine] failed reason=${safe}`);
    await upsertBackupHistoryRecord(backupDir, {
      backupId: filename,
      createdAt: now.toISOString(),
      triggerType: input.triggerType,
      archiveSha256: "",
      archiveBytes: 0,
      databaseSha256: "",
      documentCount: 0,
      status: "failed",
      replicationStatus: "none",
      destinations: [],
    });
    return {
      ran: true,
      backup: {
        backupId: filename,
        createdAt: now.toISOString(),
        triggerType: input.triggerType,
        status: "failed",
        message: safe,
      },
      replicationStatus: "none",
      destinations: [],
    };
  }

  const handle: VerifiedArchiveHandle = {
    filename,
    sha256: verified.sha256,
    bytes: verified.bytes,
    databaseSha256: verified.databaseSha256,
    documentCount: verified.documents,
    createdAt: now.toISOString(),
    localPath: path.join(backupDir, filename),
  };

  // السجل قبل الوجهات: النسخة verified بمجرد تحققها — الوجهات تفصيلٌ يُستكمل.
  await upsertBackupHistoryRecord(backupDir, {
    backupId: filename,
    createdAt: handle.createdAt,
    triggerType: input.triggerType,
    archiveSha256: handle.sha256,
    archiveBytes: handle.bytes,
    databaseSha256: handle.databaseSha256,
    documentCount: handle.documentCount,
    status: "verified",
    replicationStatus: "none",
    destinations: [],
  });

  // النسخ إلى الوجهات — فشلُ وجهةٍ لا يمسّ الأصل ولا يعيد البناء.
  const providers = input.providers ?? destinationProviders();
  const results: DestinationResult[] = [];
  for (const provider of providers) {
    const result = await provider.replicate(handle, { config: input.config });
    results.push(result);
    if (result.status === "failed") {
      log(`[backup-engine] destination ${provider.type} failed reason=${result.detail ?? "غير معروف"}`);
    }
  }
  const replicationStatus = replicationStatusOf(results);
  await updateBackupHistoryRecord(backupDir, filename, {
    replicationStatus,
    destinations: results,
  });

  log(`[backup-engine] completed filename=${filename} bytes=${handle.bytes} sha256=${handle.sha256} replication=${replicationStatus}`);

  // الاحتفاظ أخيرًا — بعد أن صارت النسخة الجديدة أحدث شهادة موجودة.
  const retention = await runBackupRetention(backupDir, {
    dailyCount: input.config.retentionDailyCount,
    weeklyCount: input.config.retentionWeeklyCount,
  });
  if (retention.deleted.length > 0 || retention.errors.length > 0) {
    log(`[backup-engine] retention deleted=${retention.deleted.length} errors=${retention.errors.length} tmpCleaned=${retention.cleanedTmpFiles.length}`);
  }

  return {
    ran: true,
    backup: {
      backupId: filename,
      createdAt: handle.createdAt,
      triggerType: input.triggerType,
      status: "verified",
      archiveSha256: handle.sha256,
      archiveBytes: handle.bytes,
      databaseSha256: handle.databaseSha256,
      documentCount: handle.documentCount,
    },
    replicationStatus,
    destinations: results,
  };
}

async function writeArchiveTmp(
  backupDir: string,
  filename: string,
  blocks: () => AsyncGenerator<Uint8Array>,
): Promise<string> {
  const { Readable } = await import("node:stream");
  return writeArchiveTmpWithFsync(backupDir, filename, Readable.from(blocks()));
}

/** إعادة النسخ للوجهات الراسبة وحدها — على الأرشيف نفسه بلا بناءٍ ثانٍ. */
export async function replicateVerifiedArchive(
  backupId: string,
  input: Omit<BackupCycleInput, "triggerType">,
  log: (message: string) => void = (message) => console.warn(message),
): Promise<{ results: DestinationResult[]; replicationStatus: "complete" | "partial" | "none" } | null> {
  let backupDir: string;
  try {
    backupDir = resolveBackupDirectory(input.volumeRoot);
    assertDocumentsDirInsideVolume(input.documentsDir, input.volumeRoot);
  } catch {
    return null;
  }

  const records = await readBackupHistory(backupDir);
  const record = records.find((entry) => entry.backupId === backupId && entry.status === "verified" && !entry.deletedAt);
  if (!record) return null;

  const { stat } = await import("node:fs/promises");
  try {
    const fileStat = await stat(path.join(backupDir, backupId));
    if (fileStat.size !== record.archiveBytes) return null;
  } catch {
    return null;
  }

  const handle: VerifiedArchiveHandle = {
    filename: backupId,
    sha256: record.archiveSha256,
    bytes: record.archiveBytes,
    databaseSha256: record.databaseSha256,
    documentCount: record.documentCount,
    createdAt: record.createdAt,
    localPath: path.join(backupDir, backupId),
  };

  const results: DestinationResult[] = [];
  const providers = input.providers ?? destinationProviders();
  for (const provider of providers) {
    const previous = record.destinations.find((entry) => entry.destination === provider.type);
    // الوجهة الناجحة سابقًا لا تُعاد — النسخ للراسب وحده، والمُنجَز يبقى منجزًا.
    if (previous?.status === "success") {
      results.push(previous);
      continue;
    }
    const result = await provider.replicate(handle, { config: input.config });
    results.push(result);
    if (result.status === "failed") {
      log(`[backup-engine] retry destination ${provider.type} failed reason=${result.detail ?? "غير معروف"}`);
    }
  }
  const replicationStatus = replicationStatusOf(results);
  await updateBackupHistoryRecord(backupDir, backupId, { replicationStatus, destinations: results });
  return { results, replicationStatus };
}

/** نوع السجل مكشوف للمستدعيات (حالة الشاشة) بلا فتح الوحدة نفسها. */
export type { BackupHistoryRecord };

import path from "node:path";
import { sanitizeErrorMessage } from "./redact";
import {
  acquireBackupLock,
  assertDocumentsDirInsideVolume,
  backupStateDir,
  isValidBackupArchiveId,
  productionBackupFilename,
  publishArchiveFile,
  releaseBackupLock,
  removeFileQuiet,
  resolveBackupArchivePath,
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
import {
  readScheduleDayClaim,
  writeScheduleDayClaim,
} from "./backupDayClaim";

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
 * ٥) النشر النهائي بربطٍ يفشل مغلقًا (لا استبدال هدفٍ قائم أبدًا) ⇒ سجل
 *    verified ⇒ نسخٌ للوجهات (فشلُ وجهةٍ ثانوية
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
  /**
   * ادعاء دور اليوم المجدول (بتوقيت العيادة) — للدورة المجدولة حصرًا.
   * الادعاء يُفحص ويُثبَّت **داخل القسم الحرج للقفل نفسه**: موجود قبل البناء
   * ⇒ لا نسخة ثانية ليومٍ مُدَّعى؛ ويُكتب بعد نسخةٍ مُتحققة داخل القفل — فلا
   * نافذة بين تحقق النسخة وتثبيت الدور يزحف فيها منافس.
   */
  scheduleClaim?: { date: string };
  /**
   * تجاوز اسم الأرشيف — **حقن اختبار حصرًا، الإنتاج لا يضبطه أبدًا**:
   * يخضع لنفس فحص الصلاحية الصارم قبل أي مسار، وتصادمه مع ملفٍ قائم
   * يفشل مغلقًا (لا استبدال) — عين ما يحدث للاسم المولَّد.
   */
  archiveFilename?: string;
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
  reason?: "backup-disabled" | "in-progress" | "misconfigured" | "already-scheduled";
  backup?: BackupCycleSummary;
  replicationStatus?: "complete" | "partial" | "none";
  destinations?: DestinationResult[];
  /**
   * نتيجة ادعاء دور اليوم — حصرًا حين طُلب ادعاء (scheduleClaim):
   * claimed = تُثبّت دوامًا داخل القفل؛ already-claimed = يوم منافس؛
   * failed = النسخة verified لكن **تثبيت الدور فشل** — لا يُبلَّغ النجاح.
   */
  scheduleDayClaim?: "claimed" | "already-claimed" | "failed";
  /** رسالة معقّمة لفشل تثبيت ادعاء اليوم حصرًا. */
  scheduleDayError?: string;
}

/**
 * الوعد المشترك داخل العملية — **مُبعث بمفتاح العملية لا للجميع**:
 * كل عمليةٍ (يدوي، مجدول ليومٍ معيّن) وعدّها الخاص، ولا يُشارك إلا المتزامنان
 * من **العملية نفسها** (ضربتا مجدول لنفس اليوم ⇒ دورةٌ واحدة بلا نسخة ثانية).
 * أما العابرون بين العمليات (يدوي أثناء مجدول أو العكس، أو مجدول ليومٍ مختلف)
 * فلا يرثون وعدَ غيرهم ولا تُنسب إليهم نتيجته — يُردّ عليهم in-progress بأمان:
 * القفل الدائم محجوز لصاحبه، ولا يُكتتب ادعاء يومٍ كذبًا، والمجدول يُعاد
 * ضربه لاحقًا فيحصل على ادعاء يومه بنسخته هو.
 */
let engineInFlight: { operationKey: string; promise: Promise<BackupCycleResult> } | null = null;

/** مفتاح العملية: مجدول ليومٍ محدد بعينه، أو يدوي — لا شيء ثالث يشاركهما. */
function operationKeyOf(input: BackupCycleInput): string {
  return input.scheduleClaim ? `scheduled:${input.scheduleClaim.date}` : "manual";
}

export async function runBackupCycle(input: BackupCycleInput): Promise<BackupCycleResult> {
  const operationKey = operationKeyOf(input);
  if (engineInFlight) {
    // العملية نفسها (نفس اليوم المجدول حصرًا) ⇒ المشاركة مقصودة: وعدٌ واحد،
    // نسخةٌ واحدة، وادعاء يومٍ واحد — مهما تعددت الضربات المتزامنة.
    if (engineInFlight.operationKey === operationKey) return engineInFlight.promise;
    // عمليةٌ مختلفة ⇒ لا مشاركة نتيجةٍ ليست لها: ردٌّ in-progress آمن —
    // القفل الدائم محجوز، والنداء اللاحق يعيد المحاولة فيدخل دوره الصحيح.
    return { ran: false, reason: "in-progress" };
  }
  const promise = executeBackupCycle(input).finally(() => {
    if (engineInFlight?.promise === promise) engineInFlight = null;
  });
  engineInFlight = { operationKey, promise };
  return promise;
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
  // ادعاء اليوم يُفحص داخل القفل أولًا: يومٌ مُدَّعى من عمليةٍ أخرى (سباق
  // الضربات عبر العمليات) ⇒ لا بناء ثاني أصلًا — هذا هو الحائط بعد أن يكون
  // المنافس قد فرغ من قفله قبل وصولنا.
  if (input.scheduleClaim) {
    const existing = await readScheduleDayClaim(backupDir, input.scheduleClaim.date);
    if (existing) {
      log(`[backup-engine] schedule-day already-claimed date=${input.scheduleClaim.date}`);
      return { ran: false, reason: "already-scheduled", scheduleDayClaim: "already-claimed" };
    }
  }

  const now = input.now ?? new Date();
  // الاسم: مولّدٌ مضمون التفرد (ملي ثانية + لاحقة عشوائية تشفيريًّا) — أو اسمٌ
  // محقون من الاختبار يُفحص من الباب. الاسم غير الصالح رفضٌ من دون مسارٍ
  // ولا سجلٍ — إنتاجًا لا يضبط الحقن أبدًا، فوجوده خطأ تكوينٍ صريح.
  let filename: string;
  if (input.archiveFilename !== undefined) {
    if (!isValidBackupArchiveId(input.archiveFilename)) {
      log("[backup-engine] rejected injected archive filename (invalid id)");
      return { ran: false, reason: "misconfigured" };
    }
    filename = input.archiveFilename;
  } else {
    filename = productionBackupFilename(now, input.appCommitSha);
  }
  log(`[backup-engine] started trigger=${input.triggerType}`);

  // البناء المؤقت + التحقق — الرسوب هنا يترك أثرَ محاولةٍ فاشلة في السجل فقط.
  let verified: Awaited<ReturnType<typeof verifyBackupArchiveFile>>;
  try {
    const blocks = input.blocks ?? (() => productionBackupArchiveBlocks({
      appCommitSha: input.appCommitSha,
      pgVersion: input.pgVersion,
      documentsDir: input.documentsDir,
    }));
    const tmpPath = await writeArchiveTmp(backupDir, filename, blocks);
    try {
      verified = await verifyBackupArchiveFile(tmpPath, input.documentsDir);
    } catch (error) {
      await removeFileQuiet(tmpPath);
      throw error;
    }
    // النشر ربطٌ يفشل مغلقًا: الهدف القائم لا يُستبدل أبدًا (EEXIST من النواة) —
    // وفشل النشر ينظّف المؤقت الخاص بهذا الفشل حصرًا.
    try {
      await publishArchiveFile(tmpPath, path.join(backupDir, filename));
    } catch (error) {
      await removeFileQuiet(tmpPath);
      throw error;
    }
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

  // ادعاء دور اليوم — **ما زلنا داخل القفل**: هذا هو جوهر الإصلاح. لا تثبيت
  // قبل نسخة مُتحققة، ولا رجوعَ للقفل قبل تثبيت الدور — فلا نافذة يزحف فيها
  // منافس بين الاكتمال والتسجيل. وفشل الكتابة لا يُبتلع: النتيجة تحمل
  // scheduleDayClaim="failed" ورسالة معقّمة — والمستدعي لا يُخبر بالنجاح.
  if (input.scheduleClaim) {
    try {
      await writeScheduleDayClaim(backupDir, input.scheduleClaim.date, filename);
      log(`[backup-engine] schedule-day claimed date=${input.scheduleClaim.date}`);
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
        scheduleDayClaim: "claimed",
      };
    } catch (error) {
      const safe = sanitizeErrorMessage(error, "تعذّر تثبيت ادعاء دور اليوم على القرص الدائم.");
      log(`[backup-engine] schedule-day claim failed reason=${safe}`);
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
        scheduleDayClaim: "failed",
        scheduleDayError: safe,
      };
    }
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

  // المعرف قادمٌ من سجلٍ مكتوب على القرص — لا يلمس مسارًا قبل الفحص المزدوج
  // (بنية الاسم + الاحتواء). معرّف مسروق السجل لا يقرأ ولا يحذف شيئًا خارجًا.
  let archivePath: string;
  try {
    archivePath = resolveBackupArchivePath(backupDir, backupId);
  } catch {
    return null;
  }

  const records = await readBackupHistory(backupDir);
  const record = records.find((entry) => entry.backupId === backupId && entry.status === "verified" && !entry.deletedAt);
  if (!record) return null;

  const { stat } = await import("node:fs/promises");
  try {
    const fileStat = await stat(archivePath);
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
    localPath: archivePath,
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

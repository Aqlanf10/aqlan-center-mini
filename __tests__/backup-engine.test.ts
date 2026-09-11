import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBackupCycle, replicateVerifiedArchive, type BackupCycleInput } from "../lib/backupEngine";
import { resolveBackupRunConfig, type BackupRunConfig } from "../lib/backupConfig";
import { backupStateDir, resolveBackupDirectory } from "../lib/backupVolume";
import { atomicWriteJson, readJsonFile } from "../lib/backupVolume";
import { readBackupHistory, upsertBackupHistoryRecord, type BackupHistoryRecord } from "../lib/backupHistory";
import { runBackupRetention, selectRetentionDeletions } from "../lib/backupRetention";
import { clinicTodayInZone, isScheduleDueNow, isValidTimeZone, nextScheduledRunIso, scheduleTimeToMinutes, zoneOffsetMinutes } from "../lib/backupSchedule";
import {
  assertExternalReplicationAllowed,
  decryptArchiveBuffer,
  encryptArchiveBuffer,
  isBackupEncryptionConfigured,
  looksEncrypted,
} from "../lib/backupEncryption";
import { replicationStatusOf, type BackupDestinationProvider, type DestinationResult } from "../lib/backupDestinations";
import { validBlocksFactory } from "./helpers/backup-blocks";
import type { SettingsMap } from "../lib/settings";

/**
 * اختبارات محرّك النسخ: الدورة المجدولة، إيقاف الجدولة، تكرار ضربات
 * المجدول، توازي اليدوي والمجدول (قفل واحد)، حساب المناطق الزمنية،
 * الاحتفاظ المحافظ، فشل مزوّدٍ لا يقتل الأصل، إعادة النسخ للوجهة الراسبة
 * بلا إعادة بناء، حتمية بصمة الأرشيف، والتشفير المعتمد.
 */

function config(overrides: Partial<BackupRunConfig> = {}): BackupRunConfig {
  return {
    backupEnabled: true,
    scheduleEnabled: true,
    scheduleTime: "03:00",
    scheduleTimeZone: "Asia/Aden",
    retentionDailyCount: 30,
    retentionWeeklyCount: 12,
    destinations: { railwayVolume: true, googleDrive: false },
    ...overrides,
  };
}

function settingsWith(values: Partial<Record<string, string>>): SettingsMap {
  // خريطة إعدادات مصغّرة تمرّ عبر resolveBackupRunConfig فقط — الوحدة النقية
  // تقرأ backup.* حصرًا.
  return {
    "backup.enabled": "true",
    "backup.schedule_enabled": "true",
    "backup.schedule_time": "03:00",
    "backup.schedule_timezone": "Asia/Aden",
    "backup.retention_daily_count": "30",
    "backup.retention_weekly_count": "12",
    "backup.destination_railway_volume": "true",
    "backup.destination_google_drive": "false",
    ...values,
  } as SettingsMap;
}

let volume: string;
let documentsDir: string;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "aqlan-engine-volume-"));
  documentsDir = path.join(volume, "documents");
  await mkdir(documentsDir, { recursive: true });
});

afterAll(async () => {
  await rm(volume, { recursive: true, force: true }).catch(() => {});
});

async function backupFiles(): Promise<string[]> {
  const backupDir = resolveBackupDirectory(volume);
  try {
    return (await readdir(backupDir)).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

async function cleanVolumeArtifacts(): Promise<void> {
  const backupDir = resolveBackupDirectory(volume);
  await rm(backupStateDir(backupDir), { recursive: true, force: true }).catch(() => {});
  for (const name of await backupFiles()) {
    await rm(path.join(backupDir, name), { force: true });
  }
  for (const name of await readdir(backupDir).catch(() => [] as string[])) {
    if (name.startsWith(".") && name.endsWith(".tmp")) {
      await rm(path.join(backupDir, name), { force: true });
    }
  }
}

function cycleInput(overrides: Partial<BackupCycleInput> = {}): BackupCycleInput {
  const { blocks } = validBlocksFactory();
  return {
    triggerType: "scheduled",
    volumeRoot: volume,
    documentsDir,
    config: config(),
    blocks,
    appCommitSha: "1d004aa8dce5d885167beab9e41832638381dab1",
    now: new Date("2026-09-12T01:30:00Z"),
    log: () => {},
    ...overrides,
  };
}

describe("الدورة المجدولة — تشغيل وسجل وعلامة اليوم", () => {
  afterEach(cleanVolumeArtifacts);

  it("دورة مجدولة ⇒ نسخة verified + history + نتائج وجهات + replicationStatus", async () => {
    const result = await runBackupCycle(cycleInput());
    expect(result.ran).toBe(true);
    expect(result.backup?.status).toBe("verified");
    expect(result.backup?.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.backup?.archiveBytes).toBeGreaterThan(0);
    expect(result.replicationStatus).toBe("complete");
    const statuses = Object.fromEntries((result.destinations ?? []).map((entry) => [entry.destination, entry.status]));
    expect(statuses.railway_volume).toBe("success");
    expect(statuses.google_drive).toBe("skipped");
    expect(statuses.local_agent).toBe("skipped");

    const history = await readBackupHistory(resolveBackupDirectory(volume));
    const record = history.find((entry) => entry.backupId === result.backup?.backupId);
    expect(record?.status).toBe("verified");
    expect(record?.triggerType).toBe("scheduled");
    expect(record?.archiveSha256).toBe(result.backup?.archiveSha256);
    expect(record?.databaseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record)).not.toMatch(/\/tmp\//);

    const files = await backupFiles();
    expect(files).toContain(result.backup?.backupId ?? "");
  });

  it("النسخ مغلق (backup.enabled=false) ⇒ لا تشغيل", async () => {
    const result = await runBackupCycle(cycleInput({ config: config({ backupEnabled: false }) }));
    expect(result).toEqual({ ran: false, reason: "backup-disabled" });
    expect(await backupFiles()).toEqual([]);
  });

  it("حساب الاستحقاق: قبل الموعد not-due، بعده due، بعد اكتمال اليوم already-ran، الجدولة موقفة disabled", () => {
    // 02:00 UTC = 05:00 عدن
    const now = new Date("2026-09-12T02:00:00Z");
    const due = (time: string, lastDate: string | null, scheduleEnabled = true) =>
      isScheduleDueNow(
        { scheduleEnabled, scheduleTime: time, scheduleTimeZone: "Asia/Aden" },
        lastDate,
        now,
      );
    expect(due("06:00", null)).toMatchObject({ due: false, reason: "not-due", today: "2026-09-12" });
    expect(due("04:30", null)).toMatchObject({ due: true, reason: "due" });
    expect(due("05:00", null)).toMatchObject({ due: true, reason: "due" });
    expect(due("04:30", "2026-09-12")).toMatchObject({ due: false, reason: "already-ran" });
    expect(due("04:30", null, false)).toMatchObject({ due: false, reason: "disabled" });
    expect(due("99:99", null)).toMatchObject({ due: false, reason: "invalid-time" });
    expect(isScheduleDueNow(
      { scheduleEnabled: true, scheduleTime: "03:00", scheduleTimeZone: "Mars/Olympus" },
      null, now,
    ).reason).toBe("invalid-timezone");
  });

  it("توقيت عدن: 02:00Z = 05:00 محليًّا بتاريخ عدن، والإزاحة 180 دقيقة، والمنطقة غير المعروفة مرفوضة", () => {
    const local = clinicTodayInZone("Asia/Aden", new Date("2026-09-12T02:00:00Z"));
    expect(local).toEqual({ date: "2026-09-12", minutesOfDay: 5 * 60 });
    expect(zoneOffsetMinutes("Asia/Aden", new Date("2026-09-12T02:00:00Z"))).toBe(180);
    expect(isValidTimeZone("Asia/Aden")).toBe(true);
    expect(isValidTimeZone("No/Such-Zone")).toBe(false);
    expect(scheduleTimeToMinutes("03:05")).toBe(185);
    expect(scheduleTimeToMinutes("24:00")).toBeNull();
    // الموعد القادم يُحسب من الإعدادات نفسها
    const next = nextScheduledRunIso({ scheduleEnabled: true, scheduleTime: "03:00", scheduleTimeZone: "Asia/Aden" }, new Date("2026-09-12T02:00:00Z"));
    // 03:00 عدن يوم 13 سبتمبر (دور 12 صار مضى بعد 03:00 محليًّا = 00:00Z)
    expect(next).toBe("2026-09-13T00:00:00.000Z");
  });

  it("خريطة الإعدادات ⇒ تكوين تشغيلي بالحدود الصحيحة", () => {
    const resolved = resolveBackupRunConfig(settingsWith({
      "backup.schedule_time": "05:30",
      "backup.retention_daily_count": "999",
      "backup.destination_google_drive": "true",
    }));
    expect(resolved.scheduleTime).toBe("05:30");
    expect(resolved.retentionDailyCount).toBe(365); // مقصوص للحد
    expect(resolved.destinations.googleDrive).toBe(true);
    expect(resolved.retentionWeeklyCount).toBe(12);
  });
});

describe("التكرار والتوازي — دورة واحدة بلا نسخة ثانية", () => {
  afterEach(cleanVolumeArtifacts);

  it("ضربتان مجدولتان متزامنتان ⇒ دورةٌ واحدة (وعد مشترك) ونسخة واحدة", async () => {
    const blocks = vi.fn(validBlocksFactory().blocks);
    const [first, second] = await Promise.all([
      runBackupCycle(cycleInput({ blocks })),
      runBackupCycle(cycleInput({ blocks })),
    ]);
    expect(first.ran).toBe(true);
    expect(second.ran).toBe(true);
    expect(first.backup?.backupId).toBe(second.backup?.backupId);
    expect(blocks).toHaveBeenCalledTimes(1);
    expect((await backupFiles()).length).toBe(1);
  });

  it("يدوي (بوابة) ومجدول (محرك) متوازيان ⇒ القفل المشترك يمنع نسخة ثانية — بالاتجاهين", async () => {
    const { runProductionBackupOnce } = await import("../lib/productionBackup");
    const { acquireBackupLock, releaseBackupLock } = await import("../lib/backupVolume");

    // اتجاه 1: المجدول بدأ، البوابة تطلب ⇒ conflict (لا نسخة ثانية).
    let releaseScheduled!: () => void;
    const scheduledGate = new Promise<void>((resolve) => { releaseScheduled = resolve; });
    const slowBlocks = async function* () {
      // الانتظار قبل أول بايت: القفل محجوز والأرشيف لم يبدأ بعد —
      // وبعد التحرير تكمل دورةً سليمة كاملة.
      await scheduledGate;
      yield* validBlocksFactory().blocks();
    };
    const scheduledRun = runBackupCycle(cycleInput({ blocks: slowBlocks }));
    await new Promise((resolve) => setTimeout(resolve, 50)); // المجدول يمسك القفل
    const gateAttempt = await runProductionBackupOnce({
      providedToken: "t", expectedToken: "t",
      volumeRoot: volume, documentsDir,
      blocks: validBlocksFactory().blocks, log: () => {},
    });
    expect(gateAttempt.kind).toBe("conflict");
    releaseScheduled();
    const scheduledResult = await scheduledRun;
    expect(scheduledResult.backup?.status).toBe("verified");
    expect((await backupFiles()).length).toBe(1);

    // اتجاه 2: البوابة تمسك القفل يدويًّا، المجدول ⇒ in-progress.
    await cleanVolumeArtifacts();
    await mkdir(backupStateDir(resolveBackupDirectory(volume)), { recursive: true });
    const held = await acquireBackupLock(backupStateDir(resolveBackupDirectory(volume)), "backup.lock");
    expect(held).not.toBe("in-progress");
    const engineAttempt = await runBackupCycle(cycleInput());
    expect(engineAttempt).toEqual({ ran: false, reason: "in-progress" });
    await releaseBackupLock(held === "in-progress" ? null : held);
  });
});

describe("الوجهات — فشل ثانوي لا يقتل الأصل، وإعادةٌ بلا إعادة بناء", () => {
  afterEach(cleanVolumeArtifacts);

  const failingDriveProvider: BackupDestinationProvider = {
    type: "google_drive",
    label: "Drive (اختبار فاشل)",
    connectionStatus: () => ({ destination: "google_drive", status: "not_connected" }),
    replicate: async () => ({ destination: "google_drive", status: "failed", detail: "Drive quota exceeded (sanitized)" }),
  };
  const succeedingDriveProvider: BackupDestinationProvider = {
    type: "google_drive",
    label: "Drive (اختبار ناجح)",
    connectionStatus: () => ({ destination: "google_drive", status: "success" }),
    replicate: async (archive) => ({
      destination: "google_drive", status: "success",
      providerFileId: "drive-file-123", bytes: archive.bytes, sha256: archive.sha256,
    }),
  };

  it("Railway ناجح + Drive فاشل ⇒ verified + partial، والأرشيف سليم على القرص", async () => {
    const blocks = vi.fn(validBlocksFactory().blocks);
    const result = await runBackupCycle(cycleInput({
      blocks,
      config: config({ destinations: { railwayVolume: true, googleDrive: true } }),
    }));
    // السجل القياسي في PR#21: Drive غير متصل — الأصل verified وreplicationStatus=complete
    // (غير المتصل لا يُحتسب فشلًا)، والفشل الصريح يُختبر بمزوّدٍ محقون أدناه.
    expect(result.backup?.status).toBe("verified");

    const injected = await runBackupCycle(cycleInput({
      blocks,
      now: new Date("2026-09-12T01:40:00Z"), // اسم مختلف — دورة مستقلة
      config: config({ destinations: { railwayVolume: true, googleDrive: true } }),
      providers: [
        { ...(await import("../lib/backupDestinations")).railwayVolumeProvider },
        failingDriveProvider,
      ],
    }));
    expect(injected.backup?.status).toBe("verified");
    expect(injected.replicationStatus).toBe("partial");
    expect(injected.destinations?.find((entry) => entry.destination === "google_drive")?.status).toBe("failed");
    // blocks مرة لكل دورة — لا إعادة بناء داخل الدورة
    expect(blocks).toHaveBeenCalledTimes(2);
    const history = await readBackupHistory(resolveBackupDirectory(volume));
    const partialRecord = history.find((entry) => entry.replicationStatus === "partial");
    expect(partialRecord?.status).toBe("verified");
    expect(partialRecord?.backupId).toBe(injected.backup?.backupId);
    // الأرشيف الجديد (partial) موجود على القرص رغم فشل الوجهة الثانوية —
    // (الأقدم في نفس اليوم حذفه الاحتفاظ ممثلًا لليوم — قاعدة معتمدة).
    expect(await backupFiles()).toContain(injected.backup?.backupId);
  });

  it("إعادة النسخ للوجهة الراسبة وحدها ⇒ نفس الأرشيف نفسه (لا blocks ثانية، لا بناء ثانٍ)", async () => {
    const blocks = vi.fn(validBlocksFactory().blocks);
    const first = await runBackupCycle(cycleInput({
      blocks,
      providers: [
        { ...(await import("../lib/backupDestinations")).railwayVolumeProvider },
        failingDriveProvider,
      ],
    }));
    expect(first.backup?.status).toBe("verified");
    const backupId = first.backup!.backupId;
    const archiveBefore = await readFile(path.join(resolveBackupDirectory(volume), backupId));
    const shaBefore = first.backup!.archiveSha256;

    const retry = await replicateVerifiedArchive(backupId, cycleInput({
      providers: [
        { ...(await import("../lib/backupDestinations")).railwayVolumeProvider },
        succeedingDriveProvider,
      ],
    }));
    expect(retry).not.toBeNull();
    expect(retry!.replicationStatus).toBe("complete");
    const drive = retry!.results.find((entry) => entry.destination === "google_drive");
    expect(drive?.status).toBe("success");
    expect(drive?.providerFileId).toBe("drive-file-123");
    expect(drive?.sha256).toBe(shaBefore);
    // blocks لم تُستدعَ ثانية — الأرشيف نفسه بلا إعادة بناء
    expect(blocks).toHaveBeenCalledTimes(1);
    const archiveAfter = await readFile(path.join(resolveBackupDirectory(volume), backupId));
    expect(archiveAfter.equals(archiveBefore)).toBe(true);
    // والسجل حُدِّث بنتائج الوجهات
    const history = await readBackupHistory(resolveBackupDirectory(volume));
    expect(history.find((entry) => entry.backupId === backupId)?.replicationStatus).toBe("complete");
  });

  it("replicationStatusOf: complete للنجاح كله، partial لجزء، none بلا نجاح، والمتصل-غير-المُحتسب مستثنى", () => {
    const result = (status: DestinationResult["status"]): DestinationResult =>
      ({ destination: "google_drive", status });
    expect(replicationStatusOf([result("success")])).toBe("complete");
    expect(replicationStatusOf([result("success"), result("failed")])).toBe("partial");
    expect(replicationStatusOf([result("failed")])).toBe("none");
    expect(replicationStatusOf([result("not_connected"), result("skipped"), result("blocked")])).toBe("none");
  });
});

describe("حتمية الأرشيف — نفس البايتات نفس البصمة", () => {
  afterEach(cleanVolumeArtifacts);

  it("دورتان بنفس المداخل ونفس now على مجلدين ⇒ بصمة gzip واحدة", async () => {
    const secondVolume = await mkdtemp(path.join(tmpdir(), "aqlan-engine-vol2-"));
    try {
      const secondDocs = path.join(secondVolume, "documents");
      await mkdir(secondDocs, { recursive: true });
      const now = new Date("2026-09-12T01:30:00Z");
      // mtime مثبّت للمداخل: ترويسة tar جزء من البايتات — الحتمية تتطلب ثباته.
      const helpers = await import("./helpers/backup-blocks");
      const deterministicBlocks = helpers.blocksFromEntries(helpers.validBackupEntries().entries, now);
      const first = await runBackupCycle(cycleInput({ now, blocks: deterministicBlocks }));
      const second = await runBackupCycle(cycleInput({ now, volumeRoot: secondVolume, documentsDir: secondDocs, blocks: deterministicBlocks }));
      expect(first.backup?.archiveSha256).toBe(second.backup?.archiveSha256);
      expect(first.backup?.archiveBytes).toBe(second.backup?.archiveBytes);
      expect(first.backup?.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(secondVolume, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("الاحتفاظ المحافظ", () => {
  const day = (offset: number): string => new Date(Date.UTC(2026, 8, 12 - offset, 3, 0, 0)).toISOString();

  function record(backupId: string, createdAt: string, overrides: Partial<BackupHistoryRecord> = {}): BackupHistoryRecord {
    return {
      backupId, createdAt, triggerType: "scheduled",
      archiveSha256: backupId.padEnd(64, "0"), archiveBytes: 100,
      databaseSha256: "d".repeat(64), documentCount: 0,
      status: "verified", replicationStatus: "none", destinations: [],
      ...overrides,
    };
  }

  it("القواعد: الأحدث محفوظ، ممثلو الأيام والأسابيع محفوظون، والبقية محذوفات", () => {
    // ثلاثة أيام متباعدة (أسابيع مختلفة)، daily=2 وweekly=1:
    // day0 الأحدث محفوظ، يوم-1 محفوظ كممثل يومي، يوم-2 محذوف (ليس ممثل أسبوع ضمن الأحدث).
    const records = [
      record("day2", day(14)),
      record("day1", day(7)),
      record("day0", day(0)),
    ];
    const deletions = selectRetentionDeletions(records, { dailyCount: 2, weeklyCount: 1 });
    expect(deletions).toEqual(["day2"]);
  });

  it("الفاشلة لا تُحتسب ولا تُحذف بالعدّ — والمُتحقق الأحدث لا يُحذف أبدًا", () => {
    const records = [
      record("newest", day(0)),
      record("old-failed", day(1), { status: "failed" }),
    ];
    expect(selectRetentionDeletions(records, { dailyCount: 1, weeklyCount: 1 })).toEqual([]);
  });

  it("آخر نجاحٍ لوجهة خارجية محفوظ مهما قدم", () => {
    const records = [
      record("newest", day(0)),
      record("drive-holding", day(30), {
        destinations: [{ destination: "google_drive", status: "success" }],
      }),
    ];
    // مع daily=1 وweekly=1 كان drive-holding سيُحذف لولا آخر نجاح خارجي.
    const deletions = selectRetentionDeletions(records, { dailyCount: 1, weeklyCount: 1 });
    expect(deletions).toEqual([]);
  });

  it("التنفيذ على القرص: حذف الملف + tombstone، وتنظيف .tmp القديم حصرًا", async () => {
    await cleanVolumeArtifacts();
    const backupDir = resolveBackupDirectory(volume);
    await mkdir(backupDir, { recursive: true });
    await mkdir(backupStateDir(backupDir), { recursive: true });

    const VALID_OLD = "production-activation-20260829-030000-1d004aa8dce5.tar.gz";
    const VALID_NEW = "production-activation-20260912-030000-1d004aa8dce5.tar.gz";
    await writeFile(path.join(backupDir, VALID_OLD), "old-archive-bytes");
    await writeFile(path.join(backupDir, VALID_NEW), "new-archive-bytes");
    await writeFile(path.join(backupDir, ".stale.tmp"), "stale");
    const { HISTORY_FILE_NAME: historyFile } = await import("../lib/backupHistory");
    await atomicWriteJson(path.join(backupStateDir(backupDir), historyFile), { records: [
      record(VALID_OLD, new Date(Date.UTC(2026, 7, 29, 3, 0, 0)).toISOString()),
      record(VALID_NEW, new Date(Date.UTC(2026, 8, 12, 3, 0, 0)).toISOString()),
    ] });

    const result = await runBackupRetention(backupDir, { dailyCount: 1, weeklyCount: 1 });
    expect(result.deleted).toEqual([VALID_OLD]);
    await expect(stat(path.join(backupDir, VALID_OLD))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stat(path.join(backupDir, VALID_NEW)).then((s) => s.size)).toBe(17);

    const tombstone = (await readJsonFile<{ records: BackupHistoryRecord[] }>(
      path.join(backupStateDir(backupDir), historyFile),
    ));
    expect(tombstone.ok).toBe(true);
    expect(tombstone.ok && tombstone.data.records.find((entry) => entry.backupId === VALID_OLD)?.deletedAt).toBeTruthy();

    // .tmp القديم يُنظَّف، والجديد يبقى
    const freshTmp = path.join(backupDir, ".fresh.tmp");
    await writeFile(freshTmp, "in-progress");
    const staleTmp = path.join(backupDir, ".stale.tmp");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(staleTmp, twoDaysAgo, twoDaysAgo);
    await runBackupRetention(backupDir, { dailyCount: 1, weeklyCount: 1 });
    await expect(stat(staleTmp)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await stat(freshTmp).then(() => true)).toBe(true);
  });

  it("سجل التاريخ مقيد بـ500 سجل", async () => {
    const backupDir = resolveBackupDirectory(volume);
    await mkdir(backupStateDir(backupDir), { recursive: true });
    for (let index = 0; index < 505; index += 1) {
      await upsertBackupHistoryRecord(backupDir, record(`b${String(index).padStart(4, "0")}`, day(index % 400)));
    }
    const records = await readBackupHistory(backupDir);
    expect(records.length).toBe(500);
  });
});

describe("التشفير المعتمد قبل النسخ الخارجي", () => {
  it("تدوير كامل: تشفير ثم فك يعيد البايتات نفسها", () => {
    const key = "a".repeat(64);
    const plain = Buffer.from("archive-bytes-تر-حساسة", "utf8");
    const encrypted = encryptArchiveBuffer(plain, key);
    expect(looksEncrypted(encrypted)).toBe(true);
    const decrypted = decryptArchiveBuffer(encrypted, key);
    expect(decrypted.equals(plain)).toBe(true);
  });

  it("تبديل بايت واحد أو مفتاح خاطئ ⇒ فشل صريح لا بيانات تالفة", () => {
    const key = "b".repeat(64);
    const encrypted = encryptArchiveBuffer(Buffer.from("secret archive"), key);
    const tampered = Uint8Array.from(encrypted);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptArchiveBuffer(tampered, key)).toThrow();
    expect(() => decryptArchiveBuffer(encrypted, "c".repeat(64))).toThrow(/مفتاح خطأ|مُعدَّل/);
  });

  it("المفتاح لا يظهر في الناتج، والبلوكِر يمنع النسخ الخارجي بلا مفتاح", () => {
    const key = "deadbeef".repeat(8);
    const encrypted = encryptArchiveBuffer(Buffer.from("x"), key);
    expect(encrypted.toString("hex")).not.toContain(key);
    expect(isBackupEncryptionConfigured({})).toBe(false);
    expect(isBackupEncryptionConfigured({ BACKUP_ENCRYPTION_KEY: key })).toBe(true);
    expect(() => assertExternalReplicationAllowed({})).toThrow(/تشفير/);
    expect(() => assertExternalReplicationAllowed({ BACKUP_ENCRYPTION_KEY: key })).not.toThrow();
  });
});

describe("علامة دور اليوم المجدول (schedule.json)", () => {
  afterEach(cleanVolumeArtifacts);

  it("النقطة الداخلية تثبّت الدور بعد verified فقط — محاكاة كتابة marker وقراءته", async () => {
    const stateDir = backupStateDir(resolveBackupDirectory(volume));
    await mkdir(stateDir, { recursive: true });
    await atomicWriteJson(path.join(stateDir, "schedule.json"), {
      lastScheduledRunDate: "2026-09-12",
      lastScheduledRunAt: new Date().toISOString(),
    });
    const marker = await readJsonFile<{ lastScheduledRunDate?: string }>(path.join(stateDir, "schedule.json"));
    expect(marker.ok && marker.data.lastScheduledRunDate).toBe("2026-09-12");
    // والاستحقاق بعده: already-ran لنفس اليوم
    expect(isScheduleDueNow(
      { scheduleEnabled: true, scheduleTime: "03:00", scheduleTimeZone: "Asia/Aden" },
      "2026-09-12",
      new Date("2026-09-12T02:00:00Z"),
    ).reason).toBe("already-ran");
  });
});

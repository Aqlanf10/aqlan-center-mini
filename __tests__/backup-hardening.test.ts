import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBackupCycle, type BackupCycleInput } from "../lib/backupEngine";
import { resolveBackupRunConfig, mergeBackupRunConfig, parseVolumeBackupConfigPatch } from "../lib/backupConfig";
import { readVolumeBackupConfig, writeVolumeBackupConfig } from "../lib/backupRuntimeConfig";
import { backupStateDir, atomicWriteJson, isValidBackupArchiveId, resolveBackupArchivePath, readJsonFile, resolveBackupDirectory } from "../lib/backupVolume";
import { readBackupHistory, upsertBackupHistoryRecord, HISTORY_FILE_NAME } from "../lib/backupHistory";
import { runBackupRetention } from "../lib/backupRetention";
import { replicationStatusOf, railwayVolumeProvider, googleDriveProvider, localAgentProvider, type DestinationResult } from "../lib/backupDestinations";
import { uniqueDocumentsByStorageKey, type BackupDocument } from "../lib/fullBackup";
import { productionBackupBlocksWithClient } from "../lib/productionBackup";
import { validBlocksFactory, storageKeyOf, sha256Of } from "./helpers/backup-blocks";

/**
 * جولة الإصلاح النهائية (PR#21 — FINAL CORRECTION ROUND) — اختبارات الوحدة:
 *
 *  * (C) توازي الرموز: الرمز الخاطئ لا ينضم لعمليةٍ جارية برمزٍ صحيح.
 *  * (E) ادعاء دور اليوم داخل القفل: يوم واحد مُتحقق عبر المنافسين، وفشل
 *    التثبيت لا يُبلَّغ نجاحًا، والفشل يسمح بإعادة المحاولة.
 *  * (F) الكتابة الذرّية بأسماء مؤقتة فريدة: بقايا عمليةٍ ماتت لا تعلق الكاتب.
 *  * (G) الاحتفاظ: معرّفات مدبَّرة تُرفض قبل أي مسار، ونجاح الحذف معلوم
 *    (لا tombstone بلا حذفٍ فعلي).
 *  * (H) replication_status: الوجهة المُفعَّلة تُحتسب أيًّا كانت نتيجتها —
 *    المستثنى الوحيد skipped. Drive مفعَّل + تشفير مفقود ⇒ partial.
 *  * (J) تجاوز التكوين الدائم: تحقق صارم ودمج فوق الإعدادات (تفعيل بلا كتابة DB).
 *  * (D) التفريد الفيزيقي: دالة التفريد النقية.
 *  * (L) documentsDir إلزامي في مولّد الإنتاج — لا اكتشافٍ ثانٍ.
 */

function config(overrides: Partial<ReturnType<typeof _baseConfig>> = {}): ReturnType<typeof _baseConfig> {
  return { ..._baseConfig(), ...overrides };
}

function _baseConfig() {
  return {
    backupEnabled: true,
    scheduleEnabled: true,
    scheduleTime: "03:00",
    scheduleTimeZone: "Asia/Aden",
    retentionDailyCount: 30,
    retentionWeeklyCount: 12,
    destinations: { railwayVolume: true, googleDrive: false },
  };
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

const VALID_ID_OLDER = "production-activation-20260829-030000-1d004aa8dce5.tar.gz";
const VALID_ID_NEWER = "production-activation-20260912-030000-1d004aa8dce5.tar.gz";

let volume: string;
let documentsDir: string;

beforeAll(async () => {
  volume = await mkdtemp(path.join(tmpdir(), "aqlan-hardening-volume-"));
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
    await rm(path.join(backupDir, name), { recursive: true, force: true });
  }
  for (const name of await readdir(backupDir).catch(() => [] as string[])) {
    if (name.startsWith(".") && name.endsWith(".tmp")) {
      await rm(path.join(backupDir, name), { force: true });
    }
  }
}

/* ─── (G) هوية الأرشيف — البنية والاحتواء قبل أي مسار ─────────────────────── */

describe("(G) فحص هوية الأرشيف", () => {
  it("النمط المعتمد يمر، وكل أشكال الاجتياز تُرفض", () => {
    expect(isValidBackupArchiveId(VALID_ID_NEWER)).toBe(true);
    expect(isValidBackupArchiveId("production-activation-20260912-030000-nohash.tar.gz")).toBe(true);
    // اجتياز المسار
    expect(isValidBackupArchiveId("../documents/anything")).toBe(false);
    expect(isValidBackupArchiveId("..")).toBe(false);
    expect(isValidBackupArchiveId("/etc/passwd.tar.gz")).toBe(false);
    expect(isValidBackupArchiveId("sub/dir/production-activation-20260912-030000-a.tar.gz")).toBe(false);
    expect(isValidBackupArchiveId("production-activation-..\\..\\evil.tar.gz")).toBe(false);
    expect(isValidBackupArchiveId("..\\production-activation-20260912-030000-a.tar.gz")).toBe(false);
    // أنماط غريبة
    expect(isValidBackupArchiveId("evil-20260912-030000-a.tar.gz")).toBe(false);
    expect(isValidBackupArchiveId("production-activation-20260912-030000-a.tar.gz/../x")).toBe(false);
    expect(isValidBackupArchiveId(".production-activation-20260912-030000-a.tar.gz")).toBe(false);
    expect(isValidBackupArchiveId("")).toBe(false);
    expect(isValidBackupArchiveId(42)).toBe(false);
  });

  it("resolveBackupArchivePath يحلّ داخل مجلد النسخ حصرًا — ولا مسار للمعرّف المرفوض", () => {
    const backupDir = "/data/backups";
    expect(resolveBackupArchivePath(backupDir, VALID_ID_NEWER)).toBe(path.join(backupDir, VALID_ID_NEWER));
    expect(() => resolveBackupArchivePath(backupDir, "../documents/anything")).toThrow();
    expect(() => resolveBackupArchivePath(backupDir, "/etc/evil.tar.gz")).toThrow();
    expect(() => resolveBackupArchivePath(backupDir, "..\\evil.tar.gz")).toThrow();
  });
});

/* ─── (G) الاحتفاظ على القرص — لا حذف خارج مجلد النسخ، ولا tombstone بلا حذف ── */

describe("(G) الاحتفاظ — الاجتياز مستحيل، ونجاح الحذف معلوم", () => {
  afterEach(cleanVolumeArtifacts);

  function record(backupId: string, overrides: Partial<Awaited<ReturnType<typeof readBackupHistory>>[number]> = {}) {
    return {
      backupId,
      createdAt: new Date(Date.UTC(2026, 8, 1, 3, 0, 0)).toISOString(),
      triggerType: "scheduled" as const,
      archiveSha256: "a".repeat(64),
      archiveBytes: 100,
      databaseSha256: "d".repeat(64),
      documentCount: 0,
      status: "verified" as const,
      replicationStatus: "none" as const,
      destinations: [],
      ...overrides,
    };
  }

  it("معرّفات مدبَّرة في السجل ⇒ رفض قبل أي وصولٍ للقرص — لا حذف خارج مجلد النسخ", async () => {
    const backupDir = resolveBackupDirectory(volume);
    await mkdir(backupStateDir(backupDir), { recursive: true });

    // ملف «سري» خارج مجلد النسخ يحمل الاسم الذي يستهدفه المعرف المدبَّر
    const documentsDir = path.join(volume, "documents");
    await mkdir(documentsDir, { recursive: true });
    const outsideTarget = path.join(documentsDir, "anything");
    await writeFile(outsideTarget, "precise-patient-bytes", "utf8");

    const evilIds = [
      "../documents/anything",
      "..%2Fdocuments%2Fanything",
      "/etc/evil.tar.gz",
      "..",
      "sub/../documents/anything",
      "production-activation-20260912-030000-a.tar.gz/../../documents/anything",
    ];
    await atomicWriteJson(path.join(backupStateDir(backupDir), HISTORY_FILE_NAME), {
      records: evilIds.map((id) => record(id)),
    });

    const result = await runBackupRetention(backupDir, { dailyCount: 1, weeklyCount: 1 });

    // لم يُحذف شيء خارج مجلد النسخ — الملف المستهدف باقٍ حرفيًّا
    expect(await readFile(outsideTarget, "utf8")).toBe("precise-patient-bytes");
    expect(result.deleted).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    // لا tombstone لمعرّف مرفوض
    const history = await readBackupHistory(backupDir);
    for (const entry of history) expect(entry.deletedAt).toBeUndefined();
  });

  it("حذفٌ فاشل (مسار أرشيف دليل وليس ملفًا) ⇒ لا deletedAt والخطأ مسجَّل", async () => {
    const backupDir = resolveBackupDirectory(volume);
    await mkdir(backupStateDir(backupDir), { recursive: true });
    await mkdir(path.join(backupDir, VALID_ID_OLDER), { recursive: true }); // دليل باسم أرشيف
    await atomicWriteJson(path.join(backupStateDir(backupDir), HISTORY_FILE_NAME), {
      records: [record(VALID_ID_OLDER), record(VALID_ID_NEWER, { createdAt: new Date(Date.UTC(2026, 8, 12, 3, 0, 0)).toISOString() })],
    });

    const result = await runBackupRetention(backupDir, { dailyCount: 1, weeklyCount: 1 });
    expect(result.deleted).not.toContain(VALID_ID_OLDER);
    expect(result.errors.length).toBeGreaterThan(0);
    const history = await readBackupHistory(backupDir);
    const stuck = history.find((entry) => entry.backupId === VALID_ID_OLDER);
    expect(stuck?.deletedAt).toBeUndefined();
  });

  it("أرشيف مفتقد من القرص رغم سجل verified ⇒ خطأ معلوم ولا deletedAt (السجل لا يكذب)", async () => {
    const backupDir = resolveBackupDirectory(volume);
    await mkdir(backupStateDir(backupDir), { recursive: true });
    await atomicWriteJson(path.join(backupStateDir(backupDir), HISTORY_FILE_NAME), {
      records: [record(VALID_ID_OLDER), record(VALID_ID_NEWER, { createdAt: new Date(Date.UTC(2026, 8, 12, 3, 0, 0)).toISOString() })],
    });

    const result = await runBackupRetention(backupDir, { dailyCount: 1, weeklyCount: 1 });
    expect(result.deleted).toEqual([]);
    expect(result.errors.some((message) => message.includes(VALID_ID_OLDER))).toBe(true);
    const history = await readBackupHistory(backupDir);
    expect(history.find((entry) => entry.backupId === VALID_ID_OLDER)?.deletedAt).toBeUndefined();
  });

  it("حذفٌ ناجح لمعرّف سليم ⇒ tombstone حقيقي بعد unlink فعلي", async () => {
    const backupDir = resolveBackupDirectory(volume);
    await mkdir(backupStateDir(backupDir), { recursive: true });
    await writeFile(path.join(backupDir, VALID_ID_OLDER), "old-archive-bytes");
    await atomicWriteJson(path.join(backupStateDir(backupDir), HISTORY_FILE_NAME), {
      records: [record(VALID_ID_OLDER), record(VALID_ID_NEWER, { createdAt: new Date(Date.UTC(2026, 8, 12, 3, 0, 0)).toISOString() })],
    });

    const result = await runBackupRetention(backupDir, { dailyCount: 1, weeklyCount: 1 });
    expect(result.deleted).toEqual([VALID_ID_OLDER]);
    await expect(stat(path.join(backupDir, VALID_ID_OLDER))).rejects.toMatchObject({ code: "ENOENT" });
    const history = await readBackupHistory(backupDir);
    expect(history.find((entry) => entry.backupId === VALID_ID_OLDER)?.deletedAt).toBeTruthy();
  });
});

/* ─── (E) ادعاء دور اليوم داخل القفل ──────────────────────────────────────── */

describe("(E) ادعاء دور اليوم — ذرّيّ مع القفل", () => {
  afterEach(cleanVolumeArtifacts);

  it("دورة مجدولة بادعاء ⇒ claimed وملف ادعاء دوام بنفس المعرف", async () => {
    const result = await runBackupCycle(cycleInput({ scheduleClaim: { date: "2026-09-12" } }));
    expect(result.ran).toBe(true);
    expect(result.backup?.status).toBe("verified");
    expect(result.scheduleDayClaim).toBe("claimed");

    const claim = await readJsonFile<{ date?: string; backupId?: string }>(
      path.join(backupStateDir(resolveBackupDirectory(volume)), "schedule-days", "2026-09-12.json"),
    );
    expect(claim.ok).toBe(true);
    expect(claim.ok && claim.data.date).toBe("2026-09-12");
    expect(claim.ok && claim.data.backupId).toBe(result.backup?.backupId);
  });

  it("منافس بعد الادعاء (يحاكي عملية ثانية) ⇒ already-scheduled ولا نسخة ثانية", async () => {
    const first = await runBackupCycle(cycleInput({ scheduleClaim: { date: "2026-09-12" } }));
    expect(first.scheduleDayClaim).toBe("claimed");
    const filesAfterFirst = await backupFiles();

    const contender = await runBackupCycle(cycleInput({
      scheduleClaim: { date: "2026-09-12" },
      now: new Date("2026-09-12T05:45:00Z"), // اسم ملف محتمل مختلف لو شُيّد
    }));
    expect(contender.ran).toBe(false);
    expect(contender.reason).toBe("already-scheduled");
    expect(contender.scheduleDayClaim).toBe("already-claimed");
    expect(contender.backup).toBeUndefined();
    expect(await backupFiles()).toEqual(filesAfterFirst);
  });

  it("فشل نسخة اليوم لا يدّعي شيئًا — إعادة المحاولة ممكنة", async () => {
    let call = 0;
    const { blocks: goodBlocks } = validBlocksFactory();
    const flaky = async function* () {
      call += 1;
      if (call === 1) {
        yield new Uint8Array(64);
        throw new Error("transient dump failure");
      }
      yield* goodBlocks();
    };
    const failed = await runBackupCycle(cycleInput({ scheduleClaim: { date: "2026-09-12" }, blocks: flaky }));
    expect(failed.backup?.status).toBe("failed");
    expect(failed.scheduleDayClaim).toBeUndefined();

    const retried = await runBackupCycle(cycleInput({ scheduleClaim: { date: "2026-09-12" } }));
    expect(retried.backup?.status).toBe("verified");
    expect(retried.scheduleDayClaim).toBe("claimed");
  });

  it("فشل كتابة الادعاء لا يُبتلع: scheduleDayClaim=failed بلا بلاغ نجاح للدور", async () => {
    // التصادم المُحكوم: مسار ملف الادعاء دليل — rename يفشل بعد نسخة مُتحققة.
    const daysDir = path.join(backupStateDir(resolveBackupDirectory(volume)), "schedule-days");
    await mkdir(daysDir, { recursive: true });
    await mkdir(path.join(daysDir, "2026-09-12.json"), { recursive: true });

    const result = await runBackupCycle(cycleInput({ scheduleClaim: { date: "2026-09-12" } }));
    expect(result.backup?.status).toBe("verified");
    expect(result.scheduleDayClaim).toBe("failed");
    expect(result.scheduleDayError).toBeTruthy();
  });

  it("قفل حيّ لعملية أخرى ⇒ in-progress بلا ادعاء (منافس عبر العمليات)", async () => {
    const { acquireBackupLock, releaseBackupLock } = await import("../lib/backupVolume");
    const stateDir = backupStateDir(resolveBackupDirectory(volume));
    await mkdir(stateDir, { recursive: true });
    const held = await acquireBackupLock(stateDir, "backup.lock");
    expect(held).not.toBe("in-progress");
    const attempt = await runBackupCycle(cycleInput({ scheduleClaim: { date: "2026-09-12" } }));
    expect(attempt.ran).toBe(false);
    expect(attempt.reason).toBe("in-progress");
    const daysListed = await readdir(path.join(stateDir, "schedule-days")).catch(() => [] as string[]);
    expect(daysListed).toEqual([]);
    await releaseBackupLock(held === "in-progress" ? null : held);
  });
});

/* ─── (F) الكتابة الذرّية بأسماء مؤقتة فريدة ──────────────────────────────── */

describe("(F) الكتابة الذرّية — بقايا عمليةٍ ماتت لا تعلق الكاتب", () => {
  afterEach(cleanVolumeArtifacts);

  it("بقايا الاسم الثابت القديم (.state.json.tmp) لا تمنع كتابة جديدة", async () => {
    const stateDir = backupStateDir(resolveBackupDirectory(volume));
    await mkdir(stateDir, { recursive: true });
    // بقايا أسلوب الكتابة القديم (اسم ثابت) من عمليةٍ ماتت قبل rename
    await writeFile(path.join(stateDir, ".state.json.tmp"), "crashed-writer-leftovers");
    await atomicWriteJson(path.join(stateDir, "state.json"), { ok: true });
    const content = await readFile(path.join(stateDir, "state.json"), "utf8");
    expect(JSON.parse(content)).toEqual({ ok: true });
  });

  it("كتابات متوازية لنفس الهدف ⇒ كلها تنجح والناتج JSON سليم", async () => {
    const stateDir = backupStateDir(resolveBackupDirectory(volume));
    await mkdir(stateDir, { recursive: true });
    const target = path.join(stateDir, "concurrent.json");
    await Promise.all([
      atomicWriteJson(target, { writer: 1 }),
      atomicWriteJson(target, { writer: 2 }),
      atomicWriteJson(target, { writer: 3 }),
    ]);
    const parsed = JSON.parse(await readFile(target, "utf8")) as { writer: number };
    expect([1, 2, 3]).toContain(parsed.writer);
    // لا بقايا مؤقتة
    const leftovers = (await readdir(stateDir)).filter((entry) => entry.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("فشل rename ينظّف مؤقت الفاشل حصرًا ولا يمسّ بقايا غيره", async () => {
    const stateDir = backupStateDir(resolveBackupDirectory(volume));
    await mkdir(stateDir, { recursive: true });
    const target = path.join(stateDir, "blocked.json");
    await mkdir(target, { recursive: true }); // rename على دليل يفشل
    const unrelatedLeftover = path.join(stateDir, ".blocked.json.deadbeef.tmp");
    await writeFile(unrelatedLeftover, "someone-elses-leftover");
    await expect(atomicWriteJson(target, { x: 1 })).rejects.toThrow();
    expect(await readFile(unrelatedLeftover, "utf8")).toBe("someone-elses-leftover");
    await rm(target, { recursive: true, force: true });
  });
});

/* ─── (H) replication_status — الوجهة المُفعَّلة تُحتسب ───────────────────── */

describe("(H) replication_status — المستثنى الوحيد skipped", () => {
  const result = (status: DestinationResult["status"]): DestinationResult =>
    ({ destination: "google_drive", status });

  it("failed/blocked/not_connected/pending تُحتسب: نجاح Railway معها ⇒ partial", () => {
    expect(replicationStatusOf([result("success"), result("failed")])).toBe("partial");
    expect(replicationStatusOf([result("success"), result("blocked")])).toBe("partial");
    expect(replicationStatusOf([result("success"), result("not_connected")])).toBe("partial");
    expect(replicationStatusOf([result("success"), result("pending")])).toBe("partial");
    expect(replicationStatusOf([result("success"), result("skipped")])).toBe("complete");
    expect(replicationStatusOf([result("skipped")])).toBe("none");
    expect(replicationStatusOf([result("success")])).toBe("complete");
    expect(replicationStatusOf([result("failed")])).toBe("none");
  });

  it("الوكيل المحلي غير المفعَّل ⇒ skipped في الدورة (لا يُعدّ نقص نسخ)", async () => {
    expect(localAgentProvider.connectionStatus({ config: config() }).status).toBe("not_connected");
    const replication = await localAgentProvider.replicate({
      filename: VALID_ID_NEWER, sha256: "a".repeat(64), bytes: 1,
      databaseSha256: "b".repeat(64), documentCount: 0,
      createdAt: new Date().toISOString(), localPath: "/tmp/irrelevant",
    }, { config: config() });
    expect(replication.status).toBe("skipped");
  });

  it("Drive مفعَّل + تشفير مفقود ⇒ blocked وreplication partial مع نجاح Railway", async () => {
    delete process.env.BACKUP_ENCRYPTION_KEY;
    const result = await runBackupCycle(cycleInput({
      config: config({ destinations: { railwayVolume: true, googleDrive: true } }),
      providers: [railwayVolumeProvider, googleDriveProvider],
    }));
    expect(result.backup?.status).toBe("verified");
    const drive = result.destinations?.find((entry) => entry.destination === "google_drive");
    expect(drive?.status).toBe("blocked");
    expect(result.replicationStatus).toBe("partial");
    expect(await backupFiles()).toContain(result.backup?.backupId ?? "missing");
  });
});

/* ─── (J) تجاوز التكوين الدائم — تفعيل بلا كتابة في قاعدة الإنتاج ────────── */

describe("(J) تجاوز التكوين الدائم (backup-config.json)", () => {
  afterEach(cleanVolumeArtifacts);

  it("تحقق صارم: أنواع ملتبسة ومفاتيح مجهولة وحدود مكسورة تُرفض", () => {
    expect(parseVolumeBackupConfigPatch({ backupEnabled: true }).ok).toBe(true);
    expect(parseVolumeBackupConfigPatch({ backupEnabled: "true" }).ok).toBe(false);
    expect(parseVolumeBackupConfigPatch({ unknownKey: 1 }).ok).toBe(false);
    expect(parseVolumeBackupConfigPatch({ scheduleTime: "24:99" }).ok).toBe(false);
    expect(parseVolumeBackupConfigPatch({ scheduleTime: "03:00" }).ok).toBe(true);
    expect(parseVolumeBackupConfigPatch({ scheduleTimeZone: "Mars/Olympus" }).ok).toBe(false);
    expect(parseVolumeBackupConfigPatch({ scheduleTimeZone: "Asia/Aden" }).ok).toBe(true);
    expect(parseVolumeBackupConfigPatch({ retentionDailyCount: 0 }).ok).toBe(false);
    expect(parseVolumeBackupConfigPatch({ retentionDailyCount: 366 }).ok).toBe(false);
    expect(parseVolumeBackupConfigPatch({ retentionWeeklyCount: 12 }).ok).toBe(true);
    expect(parseVolumeBackupConfigPatch({ destinations: { googleDrive: true } }).ok).toBe(true);
    expect(parseVolumeBackupConfigPatch({ destinations: { s3: true } }).ok).toBe(false);
    expect(parseVolumeBackupConfigPatch({} as Record<string, unknown>).ok).toBe(false);
  });

  it("قراءة غائب/تالف/حاضر، وكتابةٌ تدمج فوق القائم ذرّيًّا", async () => {
    const backupDir = resolveBackupDirectory(volume);
    await mkdir(backupStateDir(backupDir), { recursive: true });

    expect((await readVolumeBackupConfig(backupDir)).status).toBe("absent");
    await writeFile(path.join(backupStateDir(backupDir), "backup-config.json"), "{not-json");
    expect((await readVolumeBackupConfig(backupDir)).status).toBe("corrupt");
    await rm(path.join(backupStateDir(backupDir), "backup-config.json"), { force: true });

    await writeVolumeBackupConfig(backupDir, { backupEnabled: true, scheduleTime: "04:15" });
    await writeVolumeBackupConfig(backupDir, { scheduleEnabled: true, destinations: { googleDrive: false } });
    const merged = await readVolumeBackupConfig(backupDir);
    expect(merged.status).toBe("present");
    if (merged.status !== "present") return;
    expect(merged.patch.backupEnabled).toBe(true);
    expect(merged.patch.scheduleTime).toBe("04:15");
    expect(merged.patch.scheduleEnabled).toBe(true);
    expect(merged.patch.destinations?.googleDrive).toBe(false);
  });

  it("الدمج فوق التكوين المحلول: آخر كلمة للتجاوز الدائم", () => {
    const base = resolveBackupRunConfig({
      "backup.enabled": "false",
      "backup.schedule_time": "03:00",
      "backup.schedule_timezone": "Asia/Aden",
      "backup.retention_daily_count": "30",
      "backup.retention_weekly_count": "12",
      "backup.destination_railway_volume": "true",
      "backup.destination_google_drive": "false",
    } as Parameters<typeof resolveBackupRunConfig>[0]);
    const effective = mergeBackupRunConfig(base, {
      backupEnabled: true,
      scheduleEnabled: true,
      scheduleTime: "05:30",
    });
    expect(effective.backupEnabled).toBe(true);
    expect(effective.scheduleEnabled).toBe(true);
    expect(effective.scheduleTime).toBe("05:30");
    expect(effective.scheduleTimeZone).toBe("Asia/Aden");
    expect(effective.retentionDailyCount).toBe(30);
  });
});

/* ─── (D) التفريد الفيزيقي و(L) documentsDir الإلزامي ────────────────────── */

describe("(D) تفريد صفوف المستندات بالمفتاح الفيزيقي", () => {
  it("صفّان بنفس storage_key ⇒ جسم فيزيائي واحد بأول وصف", () => {
    const key = storageKeyOf("shared-bytes");
    const documents: BackupDocument[] = [
      { id: 1, storage_key: key, sha256: sha256Of("shared-bytes"), size_bytes: 12 },
      { id: 2, storage_key: key, sha256: sha256Of("shared-bytes"), size_bytes: 12 },
      { id: 3, storage_key: storageKeyOf("other-bytes"), sha256: sha256Of("other-bytes"), size_bytes: 11 },
    ];
    const unique = uniqueDocumentsByStorageKey(documents);
    expect(unique).toHaveLength(2);
    expect(unique[0].id).toBe(1);
    expect(unique.map((document) => document.storage_key)).toEqual(
      [key, storageKeyOf("other-bytes")]);
  });
});

describe("(L) مولّد الإنتاج يفرض documentsDir المُتحقَّق منه — لا اكتشافٍ ثانٍ", () => {
  it("غياب documentsDir ⇒ خطأ قبل أي استعلامٍ للقاعدة", async () => {
    const queries: string[] = [];
    const fakeClient = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    };
    const options = { appCommitSha: null, pgVersion: "18" } as unknown as Parameters<typeof productionBackupBlocksWithClient>[1];
    await expect(async () => {
      for await (const _ of productionBackupBlocksWithClient(fakeClient as never, options)) void _;
    }).rejects.toThrow(/documentsDir|دليل المستندات/u);
    expect(queries).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  deleteVerifiedBackupArchive,
  manualBackupDeleteProtection,
} from "../lib/backupAdmin";
import {
  readBackupHistory,
  upsertBackupHistoryRecord,
  type BackupHistoryRecord,
} from "../lib/backupHistory";
import { backupStateDir } from "../lib/backupVolume";

const dirs: string[] = [];

function record(backupId: string, createdAt: string, external = false): BackupHistoryRecord {
  return {
    backupId,
    createdAt,
    triggerType: "manual",
    archiveSha256: "a".repeat(64),
    archiveBytes: 1234,
    databaseSha256: "b".repeat(64),
    documentCount: 2,
    status: "verified",
    replicationStatus: "complete",
    destinations: [
      { destination: "railway_volume", status: "success" },
      ...(external ? [{ destination: "google_drive" as const, status: "success" as const }] : []),
    ],
  };
}

async function setup(records: BackupHistoryRecord[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "backup-admin-"));
  dirs.push(dir);
  await mkdir(backupStateDir(dir), { recursive: true });
  for (const item of records) {
    await writeFile(path.join(dir, item.backupId), "verified-backup");
    await upsertBackupHistoryRecord(dir, item);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("حذف النسخ يدويًا للمدير", () => {
  const newest = "production-backup-20260920-030000-000-abcdef12-a1b2c3d4.tar.gz";
  const older = "production-backup-20260919-030000-000-abcdef12-b1c2d3e4.tar.gz";

  it("يحمي أحدث نسخة Verified ويحذف القديمة فقط مع tombstone", async () => {
    const records = [
      record(newest, "2026-09-20T03:00:00.000Z"),
      record(older, "2026-09-19T03:00:00.000Z"),
    ];
    expect(manualBackupDeleteProtection(records, newest)).toBe("latest-verified");
    expect(manualBackupDeleteProtection(records, older)).toBeNull();

    const dir = await setup(records);
    const result = await deleteVerifiedBackupArchive({
      backupDir: dir,
      backupId: older,
      actor: "admin",
      reason: "نسخة قديمة بعد تحقق النسخة الأحدث",
    });
    expect(result.ok).toBe(true);
    await expect(stat(path.join(dir, older))).rejects.toMatchObject({ code: "ENOENT" });

    const history = await readBackupHistory(dir);
    const tombstone = history.find((item) => item.backupId === older)!;
    expect(tombstone.status).toBe("deleted");
    expect(tombstone.deletedAt).toBeTruthy();
    expect(tombstone.deletedBy).toBe("admin");
    expect(tombstone.deletionReason).toContain("نسخة قديمة");
  });

  it("يرفض حذف النسخة المتحققة الوحيدة", async () => {
    const only = [record(newest, "2026-09-20T03:00:00.000Z")];
    expect(manualBackupDeleteProtection(only, newest)).toBe("only-verified");
  });

  it("يحمي آخر نجاح لوجهة خارجية حتى لو لم يكن أحدث Backup", async () => {
    const records = [
      record(newest, "2026-09-20T03:00:00.000Z", false),
      record(older, "2026-09-19T03:00:00.000Z", true),
    ];
    expect(manualBackupDeleteProtection(records, older)).toBe("external-anchor");
  });
});

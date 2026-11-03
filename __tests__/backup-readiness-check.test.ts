import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateBackupReadinessCheck } from "../lib/backup-readiness-check";
import { upsertBackupHistoryRecord } from "../lib/backupHistory";
import { atomicWriteJson, backupStateDir, resolveBackupDirectory } from "../lib/backupVolume";
import { RESTORE_DRILL_STATE_FILE, type RestoreDrillState } from "../lib/restore/admin";
import { SETTING_DEFAULTS, type SettingKey } from "../lib/settings";

const NOW_ISO = "2026-10-31T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

describe("evaluateBackupReadinessCheck (S22 / R53)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  function baseSettings(overrides: Partial<Record<SettingKey, string>> = {}): Record<SettingKey, string> {
    return { ...SETTING_DEFAULTS, ...overrides };
  }

  it("never reports unconditional pass on a fresh install without archive, external copy, or restore drill", async () => {
    const check = await evaluateBackupReadinessCheck({
      settings: baseSettings(),
      auditEvidence: { lastCompletedExportAt: null, startedDownloadCount: 0 },
      env: {} as NodeJS.ProcessEnv,
      nowMs: NOW_MS,
    });
    expect(check.id).toBe("backup_system");
    expect(check.status).toBe("warn");
    expect(check.description).toContain("لم يُسجّل أي أرشيف متحقق أو تصدير مكتمل بعد");
    expect(check.description).toContain("النسخة الخارجية غير مثبتة");
    expect(check.description).toContain("تمرين الاستعادة لم يُثبت بعد");
    expect(check.actionHref).toBe("/settings/backup");
  });

  it("distinguishes an interrupted/started download from a verified completed archive", async () => {
    const check = await evaluateBackupReadinessCheck({
      settings: baseSettings(),
      auditEvidence: { lastCompletedExportAt: null, startedDownloadCount: 2 },
      env: {} as NodeJS.ProcessEnv,
      nowMs: NOW_MS,
    });
    expect(check.status).toBe("warn");
    expect(check.description).toContain("سُجّل بدء تنزيل يدوي دون شهادة اكتمال أرشيف متحقق");
  });

  it("warns when a fresh verified volume archive lacks external off-site replication or a restore drill", async () => {
    const volumeRoot = await mkdtemp(path.join(os.tmpdir(), "syn-bkp-ready-"));
    tempDirs.push(volumeRoot);
    const backupDir = resolveBackupDirectory(volumeRoot);
    await mkdir(backupStateDir(backupDir), { recursive: true });
    await upsertBackupHistoryRecord(backupDir, {
      backupId: "2026-10-30T03-00-00Z",
      createdAt: "2026-10-30T03:00:00.000Z",
      triggerType: "scheduled",
      archiveSha256: "a".repeat(64),
      archiveBytes: 4096,
      databaseSha256: "b".repeat(64),
      documentCount: 0,
      status: "verified",
      replicationStatus: "none",
      destinations: [{ destination: "railway_volume", status: "success" }],
    });

    const check = await evaluateBackupReadinessCheck({
      settings: baseSettings({ "backup.enabled": "true" }),
      auditEvidence: { lastCompletedExportAt: null, startedDownloadCount: 0 },
      env: { RAILWAY_VOLUME_MOUNT_PATH: volumeRoot } as unknown as NodeJS.ProcessEnv,
      nowMs: NOW_MS,
    });
    expect(check.status).toBe("warn");
    expect(check.description).toContain("محرك النسخ الدائم مفعّل");
    expect(check.description).toContain("آخر أرشيف متحقق منذ 1 يومًا");
    expect(check.description).toContain("النسخة الخارجية غير مثبتة");
    expect(check.description).toContain("تمرين الاستعادة لم يُثبت بعد");
  });

  it("warns when the verified archive is stale (> 7 days) even with off-site copy and restore drill", async () => {
    const volumeRoot = await mkdtemp(path.join(os.tmpdir(), "syn-bkp-stale-"));
    tempDirs.push(volumeRoot);
    const backupDir = resolveBackupDirectory(volumeRoot);
    await mkdir(backupStateDir(backupDir), { recursive: true });
    await upsertBackupHistoryRecord(backupDir, {
      backupId: "2026-10-20T03-00-00Z",
      createdAt: "2026-10-20T03:00:00.000Z",
      triggerType: "scheduled",
      archiveSha256: "a".repeat(64),
      archiveBytes: 4096,
      databaseSha256: "b".repeat(64),
      documentCount: 0,
      status: "verified",
      replicationStatus: "complete",
      destinations: [
        { destination: "railway_volume", status: "success" },
        { destination: "s3", status: "success", providerFileId: "syn-s3-1" },
      ],
    });
    const drill: RestoreDrillState = {
      backupId: "2026-10-20T03-00-00Z",
      requestedAt: "2026-10-20T04:00:00.000Z",
      completedAt: "2026-10-20T04:02:00.000Z",
      requestedBy: "syn-owner",
      status: "ready",
      targetEnvironment: "staging",
      archiveSha256: "a".repeat(64),
      documentsVerified: 0,
      tablesCount: 40,
      durationMs: 1200,
      readyForCutover: true,
      errorCode: null,
    };
    await atomicWriteJson(path.join(backupStateDir(backupDir), RESTORE_DRILL_STATE_FILE), drill);

    const check = await evaluateBackupReadinessCheck({
      settings: baseSettings({ "backup.enabled": "true" }),
      auditEvidence: { lastCompletedExportAt: null, startedDownloadCount: 0 },
      env: { RAILWAY_VOLUME_MOUNT_PATH: volumeRoot } as unknown as NodeJS.ProcessEnv,
      nowMs: NOW_MS,
    });
    expect(check.status).toBe("warn");
    expect(check.description).toContain("قديم منذ 11 يومًا");
  });

  it("reports pass ONLY when verified archive <= 7d AND external off-site copy AND restore drill all succeed", async () => {
    const volumeRoot = await mkdtemp(path.join(os.tmpdir(), "syn-bkp-pass-"));
    tempDirs.push(volumeRoot);
    const backupDir = resolveBackupDirectory(volumeRoot);
    await mkdir(backupStateDir(backupDir), { recursive: true });
    await upsertBackupHistoryRecord(backupDir, {
      backupId: "2026-10-30T03-00-00Z",
      createdAt: "2026-10-30T03:00:00.000Z",
      triggerType: "scheduled",
      archiveSha256: "c".repeat(64),
      archiveBytes: 8192,
      databaseSha256: "d".repeat(64),
      documentCount: 3,
      status: "verified",
      replicationStatus: "complete",
      destinations: [
        { destination: "railway_volume", status: "success" },
        { destination: "s3", status: "success", providerFileId: "syn-s3-ok" },
      ],
    });
    const drill: RestoreDrillState = {
      backupId: "2026-10-30T03-00-00Z",
      requestedAt: "2026-10-30T04:00:00.000Z",
      completedAt: "2026-10-30T04:01:00.000Z",
      requestedBy: "syn-owner",
      status: "ready",
      targetEnvironment: "staging",
      archiveSha256: "c".repeat(64),
      documentsVerified: 3,
      tablesCount: 42,
      durationMs: 950,
      readyForCutover: true,
      errorCode: null,
    };
    await atomicWriteJson(path.join(backupStateDir(backupDir), RESTORE_DRILL_STATE_FILE), drill);

    const check = await evaluateBackupReadinessCheck({
      settings: baseSettings({ "backup.enabled": "true" }),
      auditEvidence: { lastCompletedExportAt: null, startedDownloadCount: 0 },
      env: { RAILWAY_VOLUME_MOUNT_PATH: volumeRoot } as unknown as NodeJS.ProcessEnv,
      nowMs: NOW_MS,
    });
    expect(check.status).toBe("pass");
    expect(check.description).toContain("آخر أرشيف متحقق منذ 1 يومًا");
    expect(check.description).toContain("نسخة خارجية مكتملة");
    expect(check.description).toContain("تمرين استعادة ناجح");
  });
});

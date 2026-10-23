import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupCycleResult } from "../lib/backupEngine";
import { sanitizeErrorMessage } from "../lib/redact";

const mocks = vi.hoisted(() => ({
  run: vi.fn(), settings: vi.fn(), storage: vi.fn(), config: vi.fn(),
  override: vi.fn(), due: vi.fn(), claim: vi.fn(), runtime: vi.fn(), directory: vi.fn(),
}));
vi.mock("@/lib/backupEngine", () => ({ runBackupCycle: mocks.run }));
vi.mock("@/lib/backupReadOnly", () => ({ getBackupSettingsReadOnly: mocks.settings }));
vi.mock("@/lib/files", () => ({ storageStatus: mocks.storage }));
vi.mock("@/lib/backupVolume", () => ({ resolveBackupDirectory: mocks.directory }));
vi.mock("@/lib/backupConfig", () => ({
  resolveBackupRunConfig: mocks.config,
  mergeBackupRunConfig: (config: unknown) => config,
}));
vi.mock("@/lib/backupRuntimeConfig", () => ({ readVolumeBackupConfig: mocks.override }));
vi.mock("@/lib/backupSchedule", () => ({ isScheduleDueNow: mocks.due }));
vi.mock("@/lib/backupDayClaim", () => ({ latestScheduleDayClaimDate: mocks.claim }));
vi.mock("@/lib/productionBackup", () => ({ productionRuntimeActivated: mocks.runtime }));

import { POST } from "../app/api/internal/backup/run/route";

// Direct handler calls only: no HTTP server, database, archive or provider I/O.
const token = "synthetic-backup-run-token";
const volume = path.resolve("synthetic-volume-never-created");
const verified: BackupCycleResult = {
  ran: true,
  backup: {
    backupId: "internal-archive-id", status: "verified", triggerType: "scheduled",
    createdAt: "2026-10-22T00:00:00.000Z", archiveSha256: "a".repeat(64),
    archiveBytes: 123, documentCount: 0, databaseSha256: "b".repeat(64),
  },
  scheduleDayClaim: "claimed", replicationStatus: "complete", destinations: [],
};
function request(authorization = `Bearer ${token}`) {
  return new Request("http://localhost/api/internal/backup/run", {
    method: "POST", headers: { authorization },
  });
}
async function response(result: BackupCycleResult) {
  mocks.run.mockResolvedValue(result);
  const res = await POST(request());
  expect(res.headers.get("cache-control")).toBe("no-store");
  return { res, body: await res.json() };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("INTERNAL_BACKUP_RUN_TOKEN", token);
  vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", volume);
  mocks.runtime.mockReturnValue(true);
  mocks.storage.mockResolvedValue({ ready: true, directory: path.join(volume, "documents") });
  mocks.directory.mockReturnValue(path.join(volume, "backups"));
  mocks.settings.mockResolvedValue({ ok: true, settings: {} });
  mocks.config.mockReturnValue({ backupEnabled: true, scheduleEnabled: true });
  mocks.override.mockResolvedValue({ status: "missing" });
  mocks.claim.mockResolvedValue(null);
  mocks.due.mockReturnValue({ due: true, today: "2026-10-22", reason: "due" });
});
afterEach(() => vi.unstubAllEnvs());

describe("internal backup run response contract", () => {
  it.each(["archive creation failed", "archive verification failed"])("returns 500 for %s", async (message) => {
    const { res, body } = await response({
      ran: true,
      backup: { backupId: "internal-id", createdAt: verified.backup!.createdAt,
        triggerType: "scheduled", status: "failed", message },
      replicationStatus: "none", destinations: [],
    });
    expect(res.status).toBe(500);
    expect(res.ok).toBe(false);
    expect(body).toEqual({ ok: false, ran: true, backup: {
      createdAt: verified.backup!.createdAt, triggerType: "scheduled", status: "failed", message,
    }, replicationStatus: "none", destinations: [] });
  });

  it("fails closed when a ran result has no verified archive summary", async () => {
    const { res, body } = await response({ ran: true });
    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, ran: true });
  });

  it("keeps verified and claimed success", async () => {
    const { res, body } = await response(verified);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, ran: true, scheduleDayClaim: "claimed",
      backup: { status: "verified" }, replicationStatus: "complete" });
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      triggerType: "scheduled", scheduleClaim: { date: "2026-10-22" },
    }));
  });

  it("preserves the existing failed day-claim contract", async () => {
    const { res, body } = await response({ ...verified,
      scheduleDayClaim: "failed", scheduleDayError: "Day claim could not be recorded",
    });
    expect(res.status).toBe(500);
    expect(body).toEqual({ ok: false, error: "schedule-day-not-recorded",
      message: "Day claim could not be recorded" });
  });

  it("keeps verified partial replication successful and reports destination statuses", async () => {
    const { res, body } = await response({ ...verified, replicationStatus: "partial",
      destinations: [
        { destination: "railway_volume", status: "success" },
        { destination: "s3", status: "failed", detail: "secret-provider-detail" },
      ],
    });
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, ran: true, backup: { status: "verified" },
      replicationStatus: "partial", destinations: [
        { destination: "railway_volume", status: "success" },
        { destination: "s3", status: "failed" },
      ] });
    expect(JSON.stringify(body)).not.toContain("secret-provider-detail");
  });

  it.each(["not-due", "already-ran", "disabled"])("keeps schedule skip %s at 200", async (reason) => {
    mocks.due.mockReturnValue({ due: false, today: "2026-10-22", reason });
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ran: false, reason });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["backup", "schedule"])("keeps %s-disabled at 200", async (disabled) => {
    mocks.config.mockReturnValue({ backupEnabled: disabled !== "backup", scheduleEnabled: disabled !== "schedule" });
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ran: false, reason: `${disabled}-disabled` });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["backup-disabled", "in-progress", "misconfigured", "already-scheduled"] as const)(
    "preserves existing engine non-run result %s", async (reason) => {
      const result: BackupCycleResult = { ran: false, reason,
        ...(reason === "already-scheduled" ? { scheduleDayClaim: "already-claimed" as const } : {}),
      };
      const { res, body } = await response(result);
      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true, ...result });
    },
  );

  it.each(["", "Bearer wrong-synthetic-token"])("rejects unauthorized requests before any backup access (%s)", async (authorization) => {
    const res = await POST(request(authorization));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false });
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });

  it.each(["failed", "verified"] as const)("exposes only the existing safe summary for %s", async (status) => {
    const sensitive = "postgresql://synthetic-user:synthetic-password@localhost/test /app/private/archive";
    const safeMessage = sanitizeErrorMessage(new Error(sensitive), "Backup operation failed");
    const { body } = await response({ ...verified,
      backup: { ...verified.backup!, status, backupId: sensitive, message: safeMessage },
      destinations: [{ destination: "s3", status: "failed", detail: sensitive }],
    });
    const serialized = JSON.stringify(body);
    for (const hidden of [sensitive, "synthetic-password", "/app/private", token, volume, "backupId", "databaseSha256", "detail"]) {
      expect(serialized).not.toContain(hidden);
    }
    expect(body.backup.message).toBe(safeMessage);
  });
});

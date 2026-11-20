import { afterEach, expect, it, vi } from "vitest";
import { POST } from "../app/api/settings/backup/restore/route";

const fixture = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../lib/backupReadOnly", () => ({
  requireBackupAdminReadOnly: async () => ({ ok: true, session: { username: "Synthetic admin", role: "admin" } }),
}));
vi.mock("../lib/restore/admin", () => ({ runAdminRestoreDrill: fixture.run }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const backupId = "production-backup-20260101-000000-001-synthetic-f00d1234.tar.gz";

it.each([
  ["not-recorded", "numbering-history-not-recorded"],
  ["reconciled", "numbering-freshness-unverified"],
])("reports successful isolated restore without cutover readiness (%s)", async (patientNumberSequence, cutoverBlocker) => {
  vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH", "/synthetic-volume");
  fixture.run.mockResolvedValue({
    ok: true, backupId, readyForCutover: false, patientNumberSequence, cutoverBlocker,
    archiveSha256: "b".repeat(64), documentsVerified: 1, tablesCount: 12,
    durationMs: 40, targetEnvironment: "test",
  });
  const response = await POST(new Request("http://synthetic.invalid/api/settings/backup/restore", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ backupId, confirmation: backupId }),
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({
    ok: true, backupId, readyForCutover: false, patientNumberSequence, cutoverBlocker,
  });
  expect(fixture.run).toHaveBeenCalledExactlyOnceWith({
    backupId, actor: "Synthetic admin", backupDir: "/synthetic-volume/backups",
  });
});

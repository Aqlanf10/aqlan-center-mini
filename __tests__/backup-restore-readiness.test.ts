import { afterEach, expect, it, vi } from "vitest";
import { readRestoreDrillState } from "../lib/restore/admin";
import { POST } from "../app/api/settings/backup/restore/route";

const mock = vi.hoisted(() => ({
  read: vi.fn(), drill: vi.fn(), staged: vi.fn(), stateWrite: vi.fn(), history: vi.fn(), verify: vi.fn(),
}));
vi.mock("node:fs/promises", async importActual => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {...actual, rm: vi.fn(), mkdir: vi.fn()};
});
vi.mock("pg", () => ({Client:class {
  async connect() {}
  async query() {}
  async end() {}
}}));
vi.mock("../lib/backupHistory", () => ({readBackupHistory: mock.history}));
vi.mock("../lib/restore/staging", () => ({stagedRestore: mock.staged}));
vi.mock("../lib/backupVolume", async importActual => {
  const actual = await importActual<typeof import("../lib/backupVolume")>();
  return {...actual, readJsonFile: mock.read, atomicWriteJson:mock.stateWrite, verifyBackupArchiveFile:mock.verify};
});
vi.mock("../lib/backupReadOnly", () => ({
  requireBackupAdminReadOnly: async () => ({ok:true,session:{role:"admin",username:"Synthetic Restore Operator"}}),
}));
vi.mock("../lib/restore/admin", async importActual => {
  const actual = await importActual<typeof import("../lib/restore/admin")>();
  return {...actual, runAdminRestoreDrill: mock.drill};
});

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const backupId="production-backup-20310512-130000-synthetic.tar.gz";

it("records an isolated restore as verified even while cutover remains blocked", async () => {
  const archiveSha256="b".repeat(64);
  const databaseSha256="a".repeat(64);
  mock.history.mockResolvedValue([{backupId,status:"verified",archiveSha256,archiveBytes:50,databaseSha256,documentCount:1}]);
  mock.verify.mockResolvedValue({sha256:archiveSha256,bytes:50,databaseSha256,documents:1});
  mock.staged.mockResolvedValue({ok:true, readyForCutover:false, cutoverBlocker:"patient-number-freshness-unverified",
    documentsVerified:1,verification:{tablesCount:8}});
  const actual=await vi.importActual<typeof import("../lib/restore/admin")>("../lib/restore/admin");
  const result=await actual.runAdminRestoreDrill({backupDir:"/synthetic",backupId,actor:"Synthetic Restore Operator",
    env:{RESTORE_DRILL_DATABASE_URL:"postgresql://synthetic@127.0.0.1/aqlan_synthetic_restore",
      RESTORE_DRILL_DATABASE_ENVIRONMENT:"test",RESTORE_DRILL_DEDICATED_TARGET:"true"}});
  expect(result).toMatchObject({ok:true,documentsVerified:1,tablesCount:8,
    readyForCutover:false,cutoverBlocker:"patient-number-freshness-unverified"});
  expect(mock.stateWrite).toHaveBeenLastCalledWith(expect.any(String),expect.objectContaining({
    status:"ready", readyForCutover:false, cutoverBlocker:"patient-number-freshness-unverified",errorCode:null,
  }));
});

it("does not repeat a historical cutover certificate when reading prior drill records", async () => {
  mock.read.mockResolvedValue({ok:true,data:{status:"ready",readyForCutover:true,
    archiveSha256:"a".repeat(64),documentsVerified:1,tablesCount:8}});
  expect(await readRestoreDrillState("/synthetic")).toMatchObject({
    status:"ready",documentsVerified:1,tablesCount:8,readyForCutover:false,cutoverBlocker:"patient-number-freshness-unverified",
  });
});

it("does not turn a still-running or failed drill into verified success", async () => {
  for (const status of ["running","failed"]) {
    mock.read.mockResolvedValue({ok:true,data:{status,readyForCutover:true}});
    expect(await readRestoreDrillState("/synthetic")).toMatchObject({status,readyForCutover:false,cutoverBlocker:null});
  }
});

it("keeps a successful isolated admin check HTTP 200 but does not certify cutover", async () => {
  vi.stubEnv("RAILWAY_VOLUME_MOUNT_PATH","/synthetic");
  mock.drill.mockResolvedValue({ok:true,backupId,readyForCutover:false,cutoverBlocker:"patient-number-freshness-unverified",
    archiveSha256:"b".repeat(64),documentsVerified:1,tablesCount:8,durationMs:400,targetEnvironment:"test"});
  const response = await POST(new Request("https://synthetic.invalid/api/settings/backup/restore",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({backupId,confirmation:backupId}),
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ok:true,readyForCutover:false,cutoverBlocker:"patient-number-freshness-unverified",
    backupId,documentsVerified:1,tablesCount:8});
  expect(mock.drill).toHaveBeenCalledOnce();
});

import { beforeEach, expect, it, vi } from "vitest";
import { stagedRestore, type StagedRestoreOptions } from "../lib/restore/staging";

const calls = vi.hoisted(() => ({
  readArchive: vi.fn(), validate: vi.fn(), catalog: vi.fn(), migrate: vi.fn(),
  status: vi.fn(), prepare: vi.fn(), client: vi.fn(), config: vi.fn(),
  snapshotConfig: vi.fn(), parseTarget: vi.fn(), mkdir: vi.fn(), write: vi.fn(),
  read: vi.fn(), rm: vi.fn(), install: vi.fn(), hold: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  mkdir: calls.mkdir, writeFile: calls.write, readFile: calls.read, rm: calls.rm,
}));
vi.mock("pg", () => ({ Client: class { constructor() { calls.client(); } } }));
vi.mock("../lib/db-tls", () => ({ parseDatabaseHost: calls.parseTarget }));
vi.mock("../lib/migrations", () => ({ loadMigrationFiles: calls.catalog, migrate: calls.migrate, migrationStatus: calls.status }));
vi.mock("../lib/restore/client-config", () => ({ restoreClientConfigFor: calls.config, restoreConfigFromSnapshot: calls.snapshotConfig }));
vi.mock("../lib/restore/archive", () => ({ readTarGzEntries: calls.readArchive }));
vi.mock("../lib/restore/validate", () => ({ validateBackupArchive: calls.validate }));
vi.mock("../lib/restore/sql.mjs", () => ({ prepareBackupSql: calls.prepare }));
vi.mock("../lib/restore/restore-hold", () => ({ RestoreHoldError: class extends Error {}, installRestoreHold: calls.hold }));

beforeEach(() => {
  vi.clearAllMocks();
  calls.readArchive.mockRejectedValue(new Error("synthetic archive read control"));
});

const options: StagedRestoreOptions = {
  archivePath: "synthetic-archive", targetUrl: "postgres://synthetic@localhost/synthetic",
  stagingDir: "/synthetic-stage", installUnregisteredProposals: calls.install,
};

it.each([false, true])("refuses true before reading or changing anything (snapshots=%s)", async (snapshots) => {
  const result = await stagedRestore({ ...options, allowNonEmptyTarget: true,
    ...(snapshots ? { archiveSnapshot: {} as never, migrationFilesSnapshot: [] as never, targetSnapshot: {} as never } : {}) });
  expect(result).toEqual({ ok: false, restoreHold: false, targetIdentity: null, validationErrors: [],
    documentsRestored: 0, documentsVerified: 0, migrationsApplied: [], sqlRowsStatementLines: 0,
    skippedMigrationRecordLines: 0, readyForCutover: false,
    verification: { criticalProbeOk: false, migrationConsistent: false, tablesCount: 0 }, cutoverSteps: [],
    errors: ["خيار allowNonEmptyTarget معطّل مؤقتًا؛ استخدم هدف استعادة جديدًا ومعزولًا."] });
  for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
});

it("does not access path, target or snapshot properties when true is supplied", async () => {
  let reads = 0;
  const inaccessible = new Proxy({ allowNonEmptyTarget: true }, {
    get(target, key) {
      if (key === "allowNonEmptyTarget") return ++reads === 1 ? target.allowNonEmptyTarget : false;
      throw new Error("unexpected option access");
    },
  }) as StagedRestoreOptions;
  expect((await stagedRestore(inaccessible)).errors).toEqual([
    "خيار allowNonEmptyTarget معطّل مؤقتًا؛ استخدم هدف استعادة جديدًا ومعزولًا.",
  ]);
  expect(reads).toBe(1);
  for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
});

it.each([undefined, false])("continues ordinary archive validation when option is %s", async (allowNonEmptyTarget) => {
  const result = await stagedRestore({ ...options, allowNonEmptyTarget });
  expect(calls.readArchive).toHaveBeenCalledOnce();
  expect(result.ok).toBe(false);
  expect(result.errors.join(" ")).toContain("synthetic archive read control");
  expect(calls.client).not.toHaveBeenCalled();
  expect(calls.migrate).not.toHaveBeenCalled();
  expect(calls.rm).not.toHaveBeenCalled();
});

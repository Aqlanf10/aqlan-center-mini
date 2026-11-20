import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { upsertBackupHistoryRecord, type BackupHistoryRecord } from "../lib/backupHistory";
import { backupStateDir } from "../lib/backupVolume";
import { readRestoreDrillState, runAdminRestoreDrill } from "../lib/restore/admin";
import { documentEntryName, readTarGzEntries } from "../lib/restore/archive";
import { stagedRestore } from "../lib/restore/staging";
import { tarEnd, tarHeader, tarPadding } from "../lib/tar";

// Real archive, SQL boundary, saved history, admin orchestration and staged
// replay. The entire database boundary is a fake; no SQL reaches PostgreSQL.
const fixture = vi.hoisted(() => ({
  spool: "", regularTmp: "", source: "", spoolWriteFails: false, spoolReadFails: false,
  reset: async () => {}, afterStat: async () => {}, opened: [] as FileHandle[],
  connects: 0, closes: 0, resets: 0, replaySql: [] as string[],
}));
vi.mock("node:os", async original => {
  const actual = await original<typeof import("node:os")>();
  fixture.regularTmp = actual.tmpdir();
  return { ...actual, tmpdir: () => fixture.spool || actual.tmpdir() };
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, createWriteStream: (target: string, options?: Parameters<typeof actual.createWriteStream>[1]) =>
    actual.createWriteStream(fixture.spoolWriteFails && basename(target) === "archive.tar" ? join(target, "output") : target, options) };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] === fixture.source) {
        fixture.opened.push(handle);
        const snapshot = await handle.stat();
        Object.defineProperty(handle, "stat", { value: async () => { await fixture.afterStat(); return snapshot; } });
      }
      return handle;
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (fixture.spoolReadFails && typeof args[0] === "string" && basename(args[0]) === "archive.tar") {
        throw new Error("Synthetic decompression spool read failure");
      }
      return actual.readFile(...args);
    },
  };
});
vi.mock("pg", () => ({ Client: class {
  async connect() { fixture.connects++; }
  async end() { fixture.closes++; }
  async query(sql: string) {
    if (sql === "DROP SCHEMA IF EXISTS public CASCADE") { fixture.resets++; await fixture.reset(); }
    if (sql.includes("BASE TABLE")) return { rows: [{ tables: 0 }] };
    if (sql.trim().startsWith("INSERT INTO patients")) fixture.replaySql.push(sql);
    return { rows: [] };
  }
} }));
vi.mock("../lib/migrations", () => ({
  loadMigrationFiles: async () => [], migrate: async () => ({ appliedVersions: ["synthetic"] }),
  migrationStatus: async () => ({ consistent: true, probe: { ok: true, missing: [] } }),
}));

const backupId = "production-backup-20260101-000000-001-synthetic-f00d1234.tar.gz";
const moment = new Date("2026-01-01T00:00:00.000Z");
const targetUrl = "postgresql://synthetic@127.0.0.1/backup_dst_synthetic";
const env = {
  DATABASE_URL: "postgresql://synthetic@127.0.0.1/backup_src_synthetic",
  RESTORE_DRILL_DATABASE_URL: targetUrl,
  RESTORE_DRILL_DATABASE_ENVIRONMENT: "test",
  RESTORE_DRILL_DEDICATED_TARGET: "true",
};
const key = "synthetic/archive-evidence.txt";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function archive(label: string, overrideSql?: string) {
  const document = Buffer.from(`Synthetic document ${label}`);
  const sql = Buffer.from(overrideSql ?? `BEGIN;\nINSERT INTO patients VALUES ('Synthetic ${label}');\nCOMMIT;\n`);
  const manifest = Buffer.from(JSON.stringify({
    format: "aqlan-full-backup", version: 1, createdAt: moment.toISOString(), databaseSha256: sha(sql), databaseBytes: sql.length,
    documents: [{ storageKey: key, sha256: sha(document), sizeBytes: document.length }],
  }));
  const parts: Uint8Array[] = [];
  for (const [name, bytes] of [["database.sql", sql], [documentEntryName(key), document], ["manifest.json", manifest]] as const) {
    parts.push(tarHeader(name, bytes.length, moment), bytes, tarPadding(bytes.length));
  }
  return { document, sql, bytes: gzipSync(Buffer.concat([...parts, tarEnd()])) };
}
let workspace: string, backupDir: string, archivePath: string, adminDocuments: string, survivor: string;
beforeEach(async () => {
  fixture.connects = 0; fixture.closes = 0; fixture.resets = 0; fixture.replaySql = [];
  fixture.spoolWriteFails = false; fixture.spoolReadFails = false; fixture.reset = async () => {};
  fixture.afterStat = async () => {}; fixture.opened = [];
  workspace = await mkdtemp(join(fixture.regularTmp, "synthetic-admin-restore-"));
  fixture.spool = join(workspace, "spool"); await mkdir(fixture.spool);
  backupDir = join(workspace, "backups");
  archivePath = join(backupDir, backupId); fixture.source = archivePath;
  adminDocuments = join(backupStateDir(backupDir), "restore-drill-current");
  await mkdir(adminDocuments, { recursive: true });
  survivor = join(adminDocuments, "synthetic-sentinel");
  await writeFile(survivor, "synthetic previous drill");
});
afterEach(async () => {
  fixture.spool = ""; fixture.source = "";
  if (workspace) await rm(workspace, { recursive: true, force: true });
});
async function register(value: ReturnType<typeof archive>, patch: Partial<BackupHistoryRecord> = {}) {
  await writeFile(archivePath, value.bytes);
  await upsertBackupHistoryRecord(backupDir, {
    backupId, createdAt: moment.toISOString(), triggerType: "manual", status: "verified", replicationStatus: "none", destinations: [],
    archiveSha256: sha(value.bytes), archiveBytes: value.bytes.length, databaseSha256: sha(value.sql), documentCount: 1, ...patch,
  });
}
const drill = (overrides: Partial<typeof env> = {}) => runAdminRestoreDrill({ backupDir, backupId, actor: "Synthetic admin", env: { ...env, ...overrides } });
async function noTargetTouch() {
  expect(fixture.connects).toBe(0); expect(fixture.resets).toBe(0); expect(fixture.replaySql).toEqual([]);
  expect(await readFile(survivor, "utf8")).toBe("synthetic previous drill");
  expect(await readRestoreDrillState(backupDir)).toBeNull();
  expect(await readdir(fixture.spool)).toEqual([]);
  expect(fixture.opened.every(handle => handle.fd === -1)).toBe(true);
}

it("replays the verified SQL and document even when reset replaces the source pathname", async () => {
  const original = archive("original-A"), replacement = archive("replacement-B");
  await register(original);
  fixture.reset = async () => {
    const next = join(backupDir, "synthetic-replacement.tmp");
    await writeFile(next, replacement.bytes); await rename(next, archivePath);
  };
  expect(await drill()).toMatchObject({ ok: true, archiveSha256: sha(original.bytes), documentsVerified: 1, readyForCutover: false });
  expect(fixture.resets).toBe(1); expect(fixture.connects).toBe(2); expect(fixture.closes).toBe(2);
  expect(fixture.opened).toHaveLength(1); expect(fixture.opened[0].fd).toBe(-1);
  expect(await readFile(archivePath)).toEqual(replacement.bytes);
  expect(fixture.replaySql).toEqual(["\nINSERT INTO patients VALUES ('Synthetic original-A');\n"]);
  expect(await readFile(join(adminDocuments, key))).toEqual(original.document);
  expect(await readdir(fixture.spool)).toEqual([]);
});
it.each(["missing", "directory", "wrong-size", "wrong-gzip-hash", "wrong-sql-hash", "wrong-document-count", "broken-gzip", "bad-sql", "spool-write-error", "spool-read-error", "growth-after-stat", "truncation-after-stat"])("refuses %s before resetting or clearing prior drill state", async problem => {
  const original = problem === "bad-sql" ? archive("malformed", "BEGIN;\n-- aqlan-patient-number-sequence-v1 5 invalid\nCOMMIT;\n") : archive("original-A");
  const patch: Partial<BackupHistoryRecord> = {};
  if (problem === "wrong-size") patch.archiveBytes = original.bytes.length - 1;
  if (problem === "wrong-gzip-hash") patch.archiveSha256 = "0".repeat(64);
  if (problem === "wrong-sql-hash") patch.databaseSha256 = "0".repeat(64);
  if (problem === "wrong-document-count") patch.documentCount = 2;
  if (problem === "broken-gzip") original.bytes = Buffer.from("not a synthetic gzip");
  await register(original, patch);
  if (problem === "missing" || problem === "directory") await rm(archivePath);
  if (problem === "directory") await mkdir(archivePath);
  fixture.spoolWriteFails = problem === "spool-write-error";
  fixture.spoolReadFails = problem === "spool-read-error";
  if (problem === "growth-after-stat") fixture.afterStat = () => appendFile(archivePath, Buffer.from("synthetic extra bytes"));
  if (problem === "truncation-after-stat") fixture.afterStat = () => truncate(archivePath, original.bytes.length - 1);
  expect(await drill()).toEqual({ ok: false, reason: "archive-integrity-mismatch" });
  await noTargetTouch();
});
it.each([{ RESTORE_DRILL_DEDICATED_TARGET: "false" }, { DATABASE_URL: targetUrl }])("keeps existing dedicated/production target guard %j", async override => {
  await register(archive("original-A"));
  expect(await drill(override)).toMatchObject({ ok: false, reason: override.DATABASE_URL ? "production-collision" : "target-not-dedicated" });
  await noTargetTouch();
});
it("preserves direct isolated restore without an admin history record or reset callback", async () => {
  const source = archive("direct"); await writeFile(archivePath, source.bytes);
  const stagingDir = join(workspace, "direct-docs");
  expect(await stagedRestore({ archivePath, stagingDir, targetUrl })).toMatchObject({
    ok: true, documentsVerified: 1, readyForCutover: false, patientNumberSequence: "not-recorded",
  });
  expect(fixture.connects).toBe(1); expect(fixture.closes).toBe(1); expect(fixture.resets).toBe(0);
  expect(await readFile(join(stagingDir, key))).toEqual(source.document);
  expect(await readdir(fixture.spool)).toEqual([]);
});

it("does not begin replay when the admitted reset fails, and cleans the spool", async () => {
  await register(archive("original-A"));
  fixture.reset = async () => { throw new Error("synthetic reset failure"); };
  expect(await drill()).toEqual({ ok: false, reason: "restore-failed" });
  expect(fixture.resets).toBe(1); expect(fixture.connects).toBe(1); expect(fixture.closes).toBe(1);
  expect(fixture.replaySql).toEqual([]);
  expect(await readRestoreDrillState(backupDir)).toMatchObject({ status: "failed", readyForCutover: false });
  expect(await readdir(fixture.spool)).toEqual([]);
});


it("enforces the stored compressed cap while streaming after a matching fstat", async () => {
  const source = archive("cap");
  await register(source);
  fixture.afterStat = () => appendFile(archivePath, gzipSync(Buffer.from("synthetic second gzip member")));
  await expect(readTarGzEntries(archivePath, { bytes: source.bytes.length, sha256: sha(source.bytes) }))
    .rejects.toThrow("Archive exceeded its stored compressed size.");
  expect(fixture.opened).toHaveLength(1);
  await noTargetTouch();
});

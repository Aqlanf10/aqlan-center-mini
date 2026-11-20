import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { HISTORICAL_BOOKING_0090, inspectHistoricalBooking0090 } from "../../lib/historical-booking-0090";
import { upsertBackupHistoryRecord } from "../../lib/backupHistory";
import { backupStateDir } from "../../lib/backupVolume";
import { runAdminRestoreDrill } from "../../lib/restore/admin";
import { parseTarBytes } from "../../lib/restore/archive";
import { stagedRestore } from "../../lib/restore/staging";
import { migrate } from "../../lib/migrations";
import { tarGzBytes } from "../helpers/backup-tar";

const published0090 = `-- Additive request metadata only; existing requests retain their original meaning.
ALTER TABLE booking_requests ADD COLUMN request_key TEXT;
ALTER TABLE booking_requests ADD COLUMN request_hash TEXT;
ALTER TABLE booking_requests ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX booking_requests_request_key_idx ON booking_requests (request_key) WHERE request_key IS NOT NULL;
`;
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const now = "2026-01-01T00:00:00.000Z";
const backupId = "production-backup-20260101-000000-001-synthetichistory-f00d1234.tar.gz";
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let directory: string, backupDir: string, archivePath: string, survivor: string;

beforeAll(async () => {
  expect(sha(published0090)).toBe(HISTORICAL_BOOKING_0090.sha256);
  fixture = await openBackupTimestampFixture(process.env);
  directory = await mkdtemp(join(tmpdir(), "aqlan-synthetic-0090-archive-"));
  backupDir = join(directory, "backups");
  archivePath = join(backupDir, backupId);
  const staging = join(backupStateDir(backupDir), "restore-drill-current");
  await mkdir(staging, {recursive:true});
  survivor = join(staging, "synthetic-sentinel");
  await writeFile(survivor, "synthetic saved document");
  await migrate(fixture.source, {apply:true});
  await fixture.source.query(published0090);
  await fixture.source.query(
    "INSERT INTO public.schema_migrations(version,name,checksum,adopted) VALUES ('0090',$1,$2,FALSE)",
    [HISTORICAL_BOOKING_0090.name,HISTORICAL_BOOKING_0090.sha256]);
  await fixture.archiveTarget.query("CREATE TABLE public.synthetic_previous_drill(label text); INSERT INTO public.synthetic_previous_drill VALUES ('synthetic previous target')");
});
afterAll(async () => {
  try { await fixture?.close(); } finally { if (directory) await rm(directory, {recursive:true,force:true}); }
});
async function officialArchive(populated: boolean) {
  await fixture.source.query("DELETE FROM public.booking_requests");
  if (populated) {
    await fixture.source.query(`INSERT INTO public.booking_requests(full_name,phone,request_key,request_hash,preferences)
      VALUES ('Synthetic historic booking','000000000','synthetic-request-key','synthetic-request-digest','{"fixture":true}'),
             ('Synthetic defaults booking','000000001',NULL,NULL,DEFAULT)`);
  }
  const source = await fixture.source.connect();
  try {
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({source})) blocks.push(block);
    return gzipSync(Buffer.concat(blocks));
  } finally { source.release(); }
}
async function admitHistory(bytes: Uint8Array) {
  const parsed = parseTarBytes(gunzipSync(bytes));
  const sql = parsed.entries.get("database.sql")!.data;
  await writeFile(archivePath, bytes);
  await upsertBackupHistoryRecord(backupDir, {backupId, createdAt: now, triggerType:"manual", status:"verified", replicationStatus:"none",
    destinations:[], archiveSha256:sha(bytes), archiveBytes:bytes.byteLength, databaseSha256:sha(sql), documentCount:0});
}
function alterSql(bytes: Uint8Array, edit: (sql:string)=>string) {
  const parsed = parseTarBytes(gunzipSync(bytes));
  const original = Buffer.from(parsed.entries.get("database.sql")!.data).toString("utf8");
  const edited = edit(original);
  expect(edited).not.toBe(original);
  const sql = Buffer.from(edited);
  const manifest = JSON.parse(Buffer.from(parsed.entries.get("manifest.json")!.data).toString("utf8"));
  const manifestBytes = Buffer.from(JSON.stringify({...manifest,databaseSha256:sha(sql),databaseBytes:sql.byteLength}));
  return tarGzBytes(parsed.order.map(name => ({name,data:name==="database.sql"?sql:
    name==="manifest.json"?manifestBytes:parsed.entries.get(name)!.data})));
}
async function noPreparation(expectedError: RegExp) {
  const direct = await stagedRestore({archivePath, targetUrl:fixture.sqlTarget.options.connectionString!, stagingDir:join(directory,"direct-docs")});
  expect(direct).toMatchObject({ok:false,readyForCutover:false,errors:[expect.stringMatching(expectedError)]});
  expect((await fixture.sqlTarget.query("SELECT to_regclass('public.booking_requests') AS target")).rows).toEqual([{target:null}]);
  const result = await runAdminRestoreDrill({backupDir, backupId, actor:"Synthetic operator", env:{
    DATABASE_URL:fixture.source.options.connectionString!,
    RESTORE_DRILL_DATABASE_URL:fixture.archiveTarget.options.connectionString!,
    RESTORE_DRILL_DATABASE_ENVIRONMENT:"test", RESTORE_DRILL_DEDICATED_TARGET:"true",
  }});
  expect(result).toEqual({ok:false,reason:"archive-integrity-mismatch"});
  expect((await fixture.archiveTarget.query("SELECT label FROM public.synthetic_previous_drill")).rows)
    .toEqual([{label:"synthetic previous target"}]);
  expect(await readFile(survivor,"utf8")).toBe("synthetic saved document");
}
it("holds a verified official archive with an empty 0090 booking table, before any target setup", async () => {
  await admitHistory(await officialArchive(false)); await noPreparation(/0090 requires/);
});
it("holds a verified official archive with populated 0090 booking metadata", async () => {
  await admitHistory(await officialArchive(true)); await noPreparation(/0090/);
});
it("holds 0090 booking INSERTs even when a rehashed archive lacks its registry row", async () => {
  const altered = alterSql(await officialArchive(true), sql => sql.replace(/^INSERT INTO schema_migrations .*VALUES \('0090'.*\);\n/m,""));
  await admitHistory(altered); await noPreparation(/0090 columns/);
});
it("holds altered 0090 metadata in a rehashed empty archive", async () => {
  const altered = alterSql(await officialArchive(false), sql => sql.replace(HISTORICAL_BOOKING_0090.sha256,"1".repeat(64)));
  await admitHistory(altered); await noPreparation(/Invalid historical booking 0090/);
});

it("proves the official archive cannot distinguish an empty exact 0090 source from a drifted one", async () => {
  async function inspectSource() {
    const client = await fixture.source.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL row_security=off");
      return await inspectHistoricalBooking0090(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  try {
    expect(await inspectSource()).toEqual({status:"verified"});
    const exact = await officialArchive(false);
    const registry = (await fixture.source.query("SELECT * FROM schema_migrations WHERE version='0090'")).rows;
    const indexDdl = published0090.split("\n").find(line => line.startsWith("CREATE UNIQUE INDEX "));
    if (!indexDdl) throw new Error("Missing pinned historical index fixture");
    await fixture.source.query("DROP INDEX public.booking_requests_request_key_idx");
    try {
      expect(await inspectSource()).toEqual({status:"hold",reason:"footprint-mismatch"});
      expect((await fixture.source.query("SELECT * FROM schema_migrations WHERE version='0090'")).rows).toEqual(registry);
      const drifted = await officialArchive(false);

      // Both are emitted by the actual official writer with valid manifest,
      // registry checksum, and fresh bytes. No hash can recover absent catalog
      // evidence from the format. Keep the unsupported-restore gate.
      expect(sha(drifted)).toBe(sha(exact));
      expect(drifted.equals(exact)).toBe(true);
      await admitHistory(drifted);
      await noPreparation(/0090 requires/);
    } finally {
      await fixture.source.query(indexDdl);
    }
  } finally { vi.useRealTimers(); }
});

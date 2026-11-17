import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { openStandalone0090Fixture } from "./_standalone-0090-fixture";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { parseTarBytes } from "../../lib/restore/archive";
import { validateBackupArchive } from "../../lib/restore/validate";
import { prepareBackupSql } from "../../lib/restore/sql.mjs";
import { backupStateDir } from "../../lib/backupVolume";
import { upsertBackupHistoryRecord } from "../../lib/backupHistory";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { SESSION_COOKIE } from "../../lib/sessionCookie";
import { normalizedRegistryCountDigest } from "../helpers/standalone-0090-comparison";

// A historical published migration, copied byte-for-byte for synthetic test
// setup only. This file is never included in the application's migration set.
const HASH_0090 = "608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25";
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const STAGE_MARKER = Buffer.from("synthetic-0090-prior-stage-must-remain");
let fixture: Awaited<ReturnType<typeof openStandalone0090Fixture>>;
let directory: string, actor: SessionPayload, server: ChildProcess | undefined;
let archives: Record<"control" | "empty" | "populated", Buffer>;

async function stopServer() {
  const child = server;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 3000);
      timeout.unref();
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.kill("SIGTERM");
    });
  }
  server = undefined;
}

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-0090-restore-secret-at-least-32-characters");
  fixture = await openStandalone0090Fixture(process.env);
  expect(new Set([fixture.source.identity.name, fixture.controlTarget.identity.name, fixture.emptyTarget.identity.name, fixture.populatedTarget.identity.name]).size).toBe(4);
  directory = await mkdtemp(path.join(tmpdir(), "synthetic-0090-restore-"));
  const source = fixture.source.pool;
  const files = await loadMigrationFiles();
  expect(files.some(file => file.version === "0090")).toBe(false);
  await migrate(source, { apply: true, files });
  const user = (await source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-0090-admin','Synthetic admin','synthetic-hash','admin') RETURNING id")).rows[0].id;
  actor = { userId:user, username:"synthetic-0090-admin", role:"admin", expiresAt:Date.now()+3600000, credentialVersion:sessionCredentialVersion("synthetic-hash") };
  async function archive(): Promise<Buffer> {
    const client = await source.connect(), blocks: Uint8Array[] = [];
    try { for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error("No synthetic documents expected"); } })) blocks.push(block); }
    finally { client.release(); }
    return gzipSync(Buffer.concat(blocks));
  }
  const control = await archive();
  const before = (await source.query("SELECT version,name,checksum,applied_at::text,adopted FROM schema_migrations ORDER BY version")).rows;
  const historicalSql = await readFile(new URL("./fixtures/0090_booking_request_preferences.sql", import.meta.url));
  expect(sha(historicalSql)).toBe(HASH_0090);
  await source.query("BEGIN");
  try {
    await source.query(historicalSql.toString("utf8"));
    await source.query("INSERT INTO schema_migrations(version,name,checksum,applied_at,adopted) VALUES('0090','booking_request_preferences',$1,'2025-03-04T05:06:07.123456Z',FALSE)", [HASH_0090]);
    await source.query("COMMIT");
  } catch (error) { await source.query("ROLLBACK"); throw error; }
  const after = (await source.query("SELECT version,name,checksum,applied_at::text,adopted FROM schema_migrations ORDER BY version")).rows;
  expect(after.filter(row => row.version !== "0090")).toEqual(before);
  expect(after).toHaveLength(before.length + 1);
  expect(after.filter(row => row.version === "0090")).toMatchObject([{version:"0090",name:"booking_request_preferences",checksum:HASH_0090,adopted:false}]);
  expect((await source.query("SELECT COUNT(*)::int AS n FROM booking_requests")).rows[0].n).toBe(0);
  const empty = await archive();
  // With no booking rows, the source application's SQL must be equivalent to
  // the pre-0090 control after removing only the exact 0090 registry line.
  // The parser separately removes the remaining, unchanged registry lines.
  const sqlOf = (bytes: Buffer) => Buffer.from(parseTarBytes(gunzipSync(bytes)).entries.get("database.sql")!.data).toString("utf8");
  const emptySql = sqlOf(empty), registry090 = emptySql.split("\n").filter(line => /^INSERT INTO schema_migrations /.test(line) && line.includes("'0090'"));
  expect(registry090.length).toBe(1);
  expect(registry090[0].includes(`'0090', 'booking_request_preferences', '${HASH_0090}'`)).toBe(true);
  expect(/, FALSE\);$/.test(registry090[0])).toBe(true);
  const stripped = emptySql.replace(`${registry090[0]}\n`, "");
  expect(stripped === emptySql).toBe(false);
  const emptyData = prepareBackupSql(stripped, {inspectHistorical0079:true}).dataSql;
  const controlData = prepareBackupSql(sqlOf(control), {inspectHistorical0079:true}).dataSql;
  expect(normalizedRegistryCountDigest(emptyData, after.length))
    .toBe(normalizedRegistryCountDigest(controlData, before.length));
  await source.query("INSERT INTO booking_requests(full_name,phone,request_key,request_hash,preferences) VALUES('Synthetic booking','000000000','synthetic-0090-key','synthetic-0090-hash','{}'::jsonb)");
  expect((await source.query("SELECT COUNT(*)::int AS n FROM booking_requests")).rows[0].n).toBe(1);
  const populated = await archive();
  archives = { control, empty, populated };
  await writeFile(path.join(directory, "synthetic-before-0090-control.tar.gz"), control);
  await writeFile(path.join(directory, "synthetic-0090-empty.tar.gz"), empty);
  await writeFile(path.join(directory, "synthetic-0090-populated.tar.gz"), populated);
}, 180000);

afterEach(stopServer);
afterAll(async () => {
  await stopServer();
  await fixture?.close();
  if (directory) console.log(`SYNTHETIC_0090_EVIDENCE_DIRECTORY=${directory}`);
  vi.unstubAllEnvs();
});

it.each(["control", "empty", "populated"] as const)("checks source history 0090 with %s booking rows on its isolated target and stage", async (kind) => {
  const target = kind === "control" ? fixture.controlTarget : kind === "empty" ? fixture.emptyTarget : fixture.populatedTarget;
  const sourceUrl = fixture.source.pool.options.connectionString!, targetUrl = target.pool.options.connectionString!;
  for (const urlText of [sourceUrl, targetUrl]) {
    const url = new URL(urlText);
    if (url.hostname !== "127.0.0.1" || url.port !== "55472" || !/^\/aqlan_0090_witness_[a-f0-9]{32}$/.test(url.pathname)) throw new Error("Synthetic owned loopback database required");
  }
  expect(sourceUrl).not.toBe(targetUrl);
  const identity = (await target.pool.query("SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
  expect(identity).toEqual(target.identity);
  if (kind !== "control") {
    await target.pool.query("CREATE TABLE synthetic_0090_sentinel (value text NOT NULL)");
    await target.pool.query("INSERT INTO synthetic_0090_sentinel VALUES ('synthetic-must-remain')");
  }
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer(); socket.on("error", reject); socket.listen(0, "127.0.0.1", () => {
      const address = socket.address(); if (!address || typeof address === "string") return reject(new Error("No synthetic port"));
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  const base = `http://127.0.0.1:${port}`, volume = path.join(directory, `volume-${kind}`), backups = path.join(volume, "backups");
  const stage = path.join(backupStateDir(backups), "restore-drill-current");
  await mkdir(stage, {recursive:true}); await mkdir(path.join(volume, "documents"), {recursive:true});
  if (kind !== "control") await writeFile(path.join(stage, "synthetic-prior-document.txt"), STAGE_MARKER);
  const bytes = archives[kind], parsed = parseTarBytes(gunzipSync(bytes));
  const validation = validateBackupArchive(parsed, {documentsDir:stage});
  expect(validation.ok).toBe(true);
  if (!validation.ok) throw new Error("Synthetic archive is structurally invalid");
  const sql = Buffer.from(validation.sql).toString("utf8");
  const registryLines = sql.split("\n").filter(line => /^INSERT INTO schema_migrations /.test(line) && line.includes("'0090'"));
  expect(registryLines.length).toBe(kind === "control" ? 0 : 1);
  if (kind !== "control") {
    expect(registryLines[0].includes("'booking_request_preferences'")).toBe(true); expect(registryLines[0].includes(HASH_0090)).toBe(true);
    expect(/, FALSE\);$/.test(registryLines[0])).toBe(true);
  }
  const bookings = sql.split("\n").filter(line => /^INSERT INTO booking_requests /.test(line));
  expect(bookings.length).toBe(kind === "populated" ? 1 : 0);
  if (kind === "populated") expect(/"request_key".*"request_hash".*"preferences"/.test(bookings[0])).toBe(true);
  const archiveId = `production-backup-20261117-010203-${kind === "control" ? "100" : kind === "empty" ? "101" : "102"}-abcde123-abcdef12.tar.gz`;
  await writeFile(path.join(backups, archiveId), bytes);
  await upsertBackupHistoryRecord(backups, { backupId:archiveId, createdAt:new Date().toISOString(), triggerType:"manual", archiveSha256:sha(bytes), archiveBytes:bytes.length,
    databaseSha256:validation.sqlSha256, documentCount:validation.documents.length, status:"verified", replicationStatus:"none", destinations:[] });
  const serverEntry = process.env.SYNTHETIC_STANDALONE_SERVER!;
  server = spawn(process.execPath, [serverEntry], {cwd:directory, env:{ PATH:process.env.PATH, SESSION_SECRET:process.env.SESSION_SECRET, CLINIC_TIME_ZONE:"Asia/Aden",
    NODE_ENV:"production", PORT:String(port), HOSTNAME:"127.0.0.1", APP_ORIGIN:base, DATABASE_URL:sourceUrl, TEST_DATABASE_URL:sourceUrl,
    DATABASE_ENVIRONMENT:"test", USE_LOCAL_DB:"false", SKIP_SEED:"true", CI:"false", RESTORE_DRILL_DATABASE_URL:targetUrl,
    RESTORE_DRILL_DATABASE_ENVIRONMENT:"test", RESTORE_DRILL_DEDICATED_TARGET:"true", RAILWAY_VOLUME_MOUNT_PATH:volume, DOCUMENTS_DIR:path.join(volume,"documents") }, stdio:["ignore","ignore","ignore"]});
  const deadline = Date.now() + 60000;
  while (true) {
    if (server.exitCode !== null) throw new Error("Synthetic 0090 server exited");
    try { if ((await fetch(`${base}/api/ping`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error("Synthetic 0090 server startup timed out");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  expect((await target.pool.query("SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows[0]).toEqual(identity);
  const response = await fetch(`${base}/api/settings/backup/restore`, {method:"POST",headers:{cookie:`${SESSION_COOKIE}=${createSessionToken(actor)}`,Origin:base,"Sec-Fetch-Site":"same-origin","Content-Type":"application/json"},body:JSON.stringify({backupId:archiveId,confirmation:archiveId})});
  const body = await response.json().catch(() => null);
  if (kind === "control") {
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ok:true,readyForCutover:true});
    expect((await target.pool.query("SELECT version FROM schema_migrations WHERE version='0090'")).rows).toEqual([]);
    return;
  }
  expect.soft(response.status).toBe(500);
  expect.soft(body).toMatchObject({ok:false,reason:"archive-integrity-mismatch"});
  const table = (await target.pool.query("SELECT to_regclass('public.synthetic_0090_sentinel') IS NOT NULL AS present")).rows[0].present;
  expect.soft(table).toBe(true);
  if (table) expect.soft((await target.pool.query("SELECT value FROM synthetic_0090_sentinel")).rows).toEqual([{value:"synthetic-must-remain"}]);
  const stageBytes = await readFile(path.join(stage, "synthetic-prior-document.txt")).catch(() => null);
  expect.soft(stageBytes).toEqual(STAGE_MARKER);
  expect.soft((await target.pool.query("SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows[0]).toEqual(identity);
}, 300000);

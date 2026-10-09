import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../lib/db";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { loadMigrationFiles as readMigrationFiles, defaultMigrationsDir } from "../../lib/migration-files";
import { COORDINATED_MIGRATION_VERSIONS, loadMigrationFiles, migrate, migrationStatus } from "../../lib/migrations";
import { createPeriodontalDomain } from "../../lib/periodontal-db";
import { PERIODONTAL_SQL } from "../../lib/periodontal-schema";
import { emptyPeriodontalSites, parsePeriodontalCommand, type PeriodontalCommand } from "../../lib/periodontal";
import { readTarGzEntries, type ParsedArchive } from "../../lib/restore/archive";
import { stagedRestore, type StagedRestoreResult } from "../../lib/restore/staging";
import { validateBackupArchive } from "../../lib/restore/validate";
import { tarEnd, tarHeader, tarPadding } from "../../lib/tar";
import { openPeriodontalFixture, periodontalCandidateMigrationVersion } from "./_periodontal-fixture";

// Candidate compatibility only: reviewed 0001–0040, invoice0041, optional legacy0042, and immutable-coverage0043 chains.
// All candidate numbering is test-only; no shipped migration or runtime activation changes.
// Replace ONLY the filesystem selection imported by stagedRestore. migrate,
// migrationStatus, archive validation, replay, PostgreSQL and transactions are real.
const selection = vi.hoisted(() => ({ directory: "" }));
vi.mock("../../lib/migrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/migrations")>();
  return { ...actual, loadMigrationFiles: vi.fn(async (directory?: string) => {
    if (!selection.directory) throw new Error("Candidate migration directory was not prepared.");
    return actual.loadMigrationFiles(directory ?? selection.directory);
  }) };
});

const ACTOR_A = "synthetic-perio-restore-a", ACTOR_B = "synthetic-perio-restore-b";
const PRECISE_TIME = "2001-02-03T04:05:06.123456Z";
const DOCUMENT_KEY = "synthetic-periodontal.txt";
const documentBytes = Buffer.from("Synthetic periodontal restore document.\n", "utf8");
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
let directory: string | undefined;
let archivePath: string, stagingDir: string;
let candidateFiles: Awaited<ReturnType<typeof readMigrationFiles>>;
let shippedCount = 0;
let shippedFiles: Awaited<ReturnType<typeof readMigrationFiles>>;
let sourceState: Awaited<ReturnType<typeof state>>;
let restored: StagedRestoreResult;
let patientA: number, patientB: number;
let replayRecordId: number;
let preciseRecordId: number;
let latestA: number;
let archive: ParsedArchive;
const refused: { name: string; result: StagedRestoreResult; relationCount: number }[] = [];
const pool = () => fixture!.pool;
const domain = (actor = ACTOR_A) => createPeriodontalDomain({ pool: pool(),
  authorizePatient: async () => ({ username: actor, role: "admin" }),
  insertAudit: (client, input) => fixture!.db.insertAuditRow(client, input) });
function command(requestKey: string, toothCode = 16, expectedHeadId: number | null = null): PeriodontalCommand {
  const sites = emptyPeriodontalSites();
  sites[0].depthMm = "99999999999999.9"; sites[0].bleeding = false;
  sites[1].depthMm = "0.00000000000001";
  sites[2].depthMm = "0"; sites[2].bleeding = true;
  sites[4].depthMm = "3.50"; sites[5].bleeding = false;
  return { requestKey, toothCode, expectedHeadId, sites };
}
const original = command("perio:restore-a-first");
async function save(patientId: number, body: PeriodontalCommand, actor = ACTOR_A) {
  const result = await domain(actor).save(patientId, body);
  if (!result.ok) throw new Error(result.message);
  return result.record;
}
async function state() {
  // Cast timestamps to text INSIDE PostgreSQL: comparing JS Date values would
  // silently hide sub-millisecond loss in a backup/restore path.
  return {
    patients: (await pool().query("SELECT id,patient_number,full_name FROM patients ORDER BY id")).rows,
    records: (await pool().query("SELECT r.*, recorded_at::text AS recorded_at FROM periodontal_records r ORDER BY id")).rows,
    sites: (await pool().query("SELECT *, depth_mm::text AS depth_mm FROM periodontal_sites ORDER BY record_id,surface,position")).rows,
    audits: (await pool().query(`SELECT a.*, created_at::text AS created_at FROM audit_log a
      WHERE action='perio.record' ORDER BY id`)).rows,
  };
}
async function transaction<T>(run: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL statement_timeout='8s'");
    const value = await run(client); await client.query("COMMIT"); return value;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
async function rawRecord(client: DbClient, patientId: number, body: PeriodontalCommand, options: {
  timestamp?: string; siteCount?: number;
} = {}) {
  const parsed = parsePeriodontalCommand(body);
  if (!parsed.ok) throw new Error(parsed.message);
  const command = parsed.value;
  const fingerprint = createHash("sha256").update(JSON.stringify({ patientId, actor: ACTOR_B,
    toothCode: command.toothCode, expectedHeadId: command.expectedHeadId, sites: command.sites })).digest("hex");
  const { rows: [row] } = await client.query<{ id: number }>(`INSERT INTO periodontal_records
    (patient_id,tooth_code,prior_record_id,request_key,request_fingerprint,recorded_by,recorded_at)
    VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,NOW())) RETURNING id`,
  [patientId, command.toothCode, command.expectedHeadId, command.requestKey, fingerprint, ACTOR_B, options.timestamp ?? null]);
  for (const site of command.sites.slice(0, options.siteCount ?? 6)) {
    await client.query(`INSERT INTO periodontal_sites (record_id,surface,position,depth_mm,bleeding)
      VALUES ($1,$2,$3,$4::numeric,$5)`, [row.id, site.surface, site.position, site.depthMm, site.bleeding]);
  }
  return row.id;
}
async function publicRelations() {
  return (await pool().query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`)).rows[0].count;
}
async function writeVariant(name: string, change: (entry: { name: string; data: Buffer }) => Buffer | null) {
  const blocks: Uint8Array[] = [];
  for (const entryName of archive.order) {
    const entry = archive.entries.get(entryName)!;
    const data = change({ name: entryName, data: Buffer.from(entry.data) });
    if (data === null) continue;
    blocks.push(tarHeader(entryName, data.length, new Date("2001-01-01T00:00:00Z")), data, tarPadding(data.length));
  }
  blocks.push(tarEnd());
  const file = path.join(directory!, `${name}.tar.gz`);
  await writeFile(file, gzipSync(Buffer.concat(blocks)));
  return file;
}

beforeAll(async () => {
  const originalEnvironment = { ...process.env };
  directory = await mkdtemp(path.join(tmpdir(), "aqlan-perio-restore-"));
  selection.directory = path.join(directory, "candidate-migrations");
  await mkdir(selection.directory);
  const shipped = await readMigrationFiles();
  shippedFiles = shipped;
  const candidateVersion = periodontalCandidateMigrationVersion(shipped);
  // Only exact reviewed baselines are accepted: 0001–0040, أو 0041–0043 بعد دمج الفواتير،
  // أو 0045–0046 (لاحقة هذه المرحلة) — والمرشّح يأخذ الفجوة المعلنة 0044 في الاختبار.
  shippedCount = shipped.length;
  expect(shipped.map((file) => file.version)).toEqual(COORDINATED_MIGRATION_VERSIONS);
  for (const file of shipped) await copyFile(path.join(defaultMigrationsDir(), file.filename), path.join(selection.directory, file.filename));
  const candidatePath = path.resolve("__tests__/postgres/fixtures/0041_periodontal_candidate.sql");
  expect(await readFile(candidatePath, "utf8")).toBe(PERIODONTAL_SQL);
  await copyFile(candidatePath, path.join(selection.directory, `${candidateVersion}_periodontal_candidate.sql`));
  candidateFiles = await readMigrationFiles(selection.directory);
  // المرشّح قد يقع في منتصف السلسلة (فجوة 0044 المعلنة بين 0043 و0045) —
  // فالمقارنة بالمجموعة المرتبة بعد استبعاد المرشّح لا بالموضع.
  expect(candidateFiles.filter((file) => file.version !== candidateVersion)).toEqual(shipped); // Includes exact SQL and SHA-256 checksums.
  expect(candidateFiles).toHaveLength(shippedCount + 1);
  expect(candidateFiles.find((file) => file.version === candidateVersion)!.sql).toBe(PERIODONTAL_SQL);

  fixture = await openPeriodontalFixture(originalEnvironment);
  const { rows: patients } = await pool().query<{ id: number }>(`INSERT INTO patients (patient_number,full_name)
    VALUES ('SYN-PERIO-RESTORE-A','Synthetic restore A'),('SYN-PERIO-RESTORE-B','Synthetic restore B') RETURNING id`);
  patientA = patients[0].id; patientB = patients[1].id;
  const firstA = await save(patientA, original); replayRecordId = firstA.id;
  latestA = (await save(patientA, command("perio:restore-a-next", 16, firstA.id))).id;
  await save(patientA, command("perio:restore-a-other", 26));
  const firstB = await save(patientB, command("perio:restore-b-first"), ACTOR_B);
  await save(patientB, command("perio:restore-b-next", 16, firstB.id), ACTOR_B);
  await save(patientB, command("perio:restore-b-other", 36), ACTOR_B);
  // Explicit valid stored precision makes the timestamp witness deterministic.
  // The real domain uses PostgreSQL NOW(), which also supports microseconds.
  preciseRecordId = await transaction(async (client) => {
    const id = await rawRecord(client, patientB, command("perio:restore-precise", 51), { timestamp: PRECISE_TIME });
    await fixture!.db.insertAuditRow(client, { action: "perio.record", entity: "patient", entityId: patientB,
      actor: ACTOR_B, actorRole: "admin", details: { recordId: id, toothCode: 51, priorRecordId: null } });
    return id;
  });
  sourceState = await state();
  expect(sourceState.records).toHaveLength(7); expect(sourceState.sites).toHaveLength(42); expect(sourceState.audits).toHaveLength(7);
  const documentPath = path.join(directory, DOCUMENT_KEY);
  await writeFile(documentPath, documentBytes);
  await pool().query(`INSERT INTO patient_documents
    (patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by)
    VALUES ($1,'other','Synthetic periodontal document','text/plain',$2,$3,$4,$5)`,
  [patientA, documentBytes.length, createHash("sha256").update(documentBytes).digest("hex"), DOCUMENT_KEY, ACTOR_A]);
  archivePath = path.join(directory, "full.tar.gz");
  const client = await pool().connect();
  try {
    await pipeline(Readable.from(fullBackupBlocks({ source: client,
      readDocument: async (key) => { if (key !== DOCUMENT_KEY) throw new Error("Unexpected synthetic document."); return readFile(documentPath); },
    })), createGzip(), createWriteStream(archivePath));
  } finally { client.release(); }
  archive = await readTarGzEntries(archivePath);
  await fixture.close(); fixture = undefined;
  fixture = await openPeriodontalFixture(originalEnvironment, { pristine: true });
  expect(await publicRelations()).toBe(0);
  stagingDir = path.join(directory, "restored-documents");

  const invalidArchives = [
    ["changed-sql", await writeVariant("changed-sql", (entry) => entry.name === "database.sql" ? Buffer.concat([entry.data, Buffer.from("-- tampered\n")]) : entry.data)],
    ["missing-manifest", await writeVariant("missing-manifest", (entry) => entry.name === "manifest.json" ? null : entry.data)],
    ["missing-document", await writeVariant("missing-document", (entry) => entry.name.startsWith("documents/") ? null : entry.data)],
    ["missing-file", path.join(directory, "does-not-exist.tar.gz")],
  ];
  for (const [name, file] of invalidArchives) {
    const result = await stagedRestore({ archivePath: file, targetUrl: fixture.url, stagingDir });
    const relationCount = await publicRelations();
    refused.push({ name, result, relationCount });
    expect(result.ok).toBe(false); expect(relationCount).toBe(0);
  }
  expect(vi.mocked(loadMigrationFiles)).not.toHaveBeenCalled();
  restored = await stagedRestore({ archivePath, targetUrl: fixture.url, stagingDir });
  expect(restored.errors).toEqual([]);
  expect(restored.ok).toBe(true);
}, 180_000);

afterAll(async () => {
  try { await fixture?.close(); }
  finally { selection.directory = ""; if (directory) await rm(directory, { recursive: true, force: true }); }
}, 30_000);

describe("candidate periodontal archive compatibility on fresh owned PostgreSQL", () => {
  it("uses real fullBackupBlocks, validation and stagedRestore with only the candidate file selection", async () => {
    const validated = validateBackupArchive(archive, { documentsDir: stagingDir });
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.errors.join("; "));
    const sql = Buffer.from(validated.sql).toString("utf8");
    expect(sql.match(/^INSERT INTO periodontal_records /gm)).toHaveLength(7);
    expect(sql.match(/^INSERT INTO periodontal_sites /gm)).toHaveLength(42);
    expect(sql).toContain("pg_get_serial_sequence('periodontal_records', 'id')");
    expect(vi.mocked(loadMigrationFiles)).toHaveBeenCalledExactlyOnceWith();
    expect(restored.migrationsApplied).toEqual(candidateFiles.map((file) => file.version));
    expect(restored.verification).toMatchObject({ criticalProbeOk: true, migrationConsistent: true });
    expect(restored).toMatchObject({ documentsRestored: 1, documentsVerified: 1, readyForCutover: true });
    expect(await readFile(path.join(stagingDir, DOCUMENT_KEY))).toEqual(documentBytes);
    expect((await pool().query("SELECT last_value::int,is_called FROM periodontal_records_id_seq")).rows)
      .toEqual([{ last_value: Math.max(...sourceState.records.map((row) => row.id)), is_called: true }]);
    const registryBefore = (await pool().query("SELECT * FROM schema_migrations ORDER BY version")).rows;
    expect(await migrate(pool(), { apply: true, files: candidateFiles })).toMatchObject({ appliedVersions: [], alreadyUpToDate: true });
    expect((await pool().query("SELECT * FROM schema_migrations ORDER BY version")).rows).toEqual(registryBefore);
    expect((await migrationStatus(pool(), candidateFiles)).consistent).toBe(true);
    expect((await readMigrationFiles()).map((file) => file.version)).toEqual(COORDINATED_MIGRATION_VERSIONS);
    expect(await readMigrationFiles()).toEqual(shippedFiles); // Exact original SQL and checksums remain unchanged.
  });
  it("preserves exact IDs, patients, teeth, predecessors, authors, request fingerprints, values and audits", async () => {
    const actual = await state();
    expect(actual.patients).toEqual(sourceState.patients);
    expect(actual.sites).toEqual(sourceState.sites);
    // Compare complete rows as well as canonical reads, never JS-number coercion.
    expect(actual.records).toEqual(sourceState.records);
    expect(actual.audits).toEqual(sourceState.audits);
    const first = await domain().read(patientA, { toothCode: 16, beforeId: null });
    expect(first).toMatchObject({ ok: true, records: [
      { id: latestA, priorRecordId: replayRecordId }, { id: replayRecordId, priorRecordId: null },
    ] });
    const values = await domain().save(patientA, original);
    expect(values).toMatchObject({ ok: true, replayed: true, record: { id: replayRecordId, sites: [
      { depthMm: "99999999999999.9", bleeding: false }, { depthMm: "0.00000000000001", bleeding: null },
      { depthMm: "0", bleeding: true }, { depthMm: null, bleeding: null },
      { depthMm: "3.5", bleeding: null }, { depthMm: null, bleeding: false },
    ] } });
  });
  it("preserves a deterministic PostgreSQL microsecond timestamp without Date truncation", async () => {
    const { rows: [row] } = await pool().query<{ exact: boolean }>(
      "SELECT recorded_at = $2::timestamptz AS exact FROM periodontal_records WHERE id=$1", [preciseRecordId, PRECISE_TIME]);
    expect(row.exact).toBe(true);
  });
  it("retains immutable values, six-site completeness and deferred predecessor ownership after replay", async () => {
    const before = await state();
    const { rows: constraints } = await pool().query(`SELECT condeferrable,condeferred FROM pg_constraint
      WHERE conrelid='periodontal_records'::regclass AND conname='periodontal_record_predecessor_owner'`);
    expect(constraints).toEqual([{ condeferrable: true, condeferred: true }]);
    const { rows: triggers } = await pool().query(`SELECT tgdeferrable,tginitdeferred FROM pg_trigger
      WHERE tgrelid='periodontal_records'::regclass AND tgname='periodontal_record_complete'`);
    expect(triggers).toEqual([{ tgdeferrable: true, tginitdeferred: true }]);
    for (const sql of ["UPDATE periodontal_records SET recorded_by='replacement' WHERE id=$1",
      "DELETE FROM periodontal_records WHERE id=$1", "UPDATE periodontal_sites SET depth_mm=2 WHERE record_id=$1",
      "DELETE FROM periodontal_sites WHERE record_id=$1"]) {
      await expect(pool().query(sql, [replayRecordId])).rejects.toMatchObject({ code: "P0001" });
    }
    await expect(transaction((client) => rawRecord(client, patientA, command("perio:restore-incomplete", 18), { siteCount: 5 })))
      .rejects.toMatchObject({ code: "P0001" });
    await expect(transaction(async (client) => {
      // UPDATE itself is permitted; the actual COMMIT must reject broken history.
      await client.query("UPDATE periodontal_records SET patient_id=$2 WHERE id=$1", [replayRecordId, patientB]);
    })).rejects.toMatchObject({ code: "23503", constraint: "periodontal_record_predecessor_owner" });
    await expect(transaction((client) => rawRecord(client, patientB, command("perio:restore-foreign", 16, replayRecordId))))
      .rejects.toMatchObject({ code: "23503", constraint: "periodontal_record_predecessor_owner" });
    expect(await state()).toEqual(before);
  });
  it("reconciles repeated request keys without new audit and allocates a noncolliding next ID", async () => {
    const before = await state();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await domain().save(patientA, structuredClone(original))).toMatchObject({ ok: true, replayed: true, record: { id: replayRecordId } });
    }
    expect(await domain().save(patientB, original)).toMatchObject({ reason: "request_conflict" });
    expect(await state()).toEqual(before);
    const next = await save(patientA, command("perio:restore-after", 16, latestA));
    expect(next.id).toBeGreaterThan(Math.max(...before.records.map((row) => row.id)));
    expect(next.priorRecordId).toBe(latestA);
    const after = await state();
    expect(after.records).toHaveLength(before.records.length + 1);
    expect(after.sites).toHaveLength(before.sites.length + 6);
    expect(after.audits).toHaveLength(before.audits.length + 1);
  });
  it("refuses corrupt or missing archives before creating any target relation", () => {
    expect(refused.map((entry) => entry.name)).toEqual(["changed-sql", "missing-manifest", "missing-document", "missing-file"]);
    for (const entry of refused) {
      expect(entry.result).toMatchObject({ ok: false, readyForCutover: false, migrationsApplied: [], documentsRestored: 0 });
      expect(entry.result.errors.length).toBeGreaterThan(0);
      expect(entry.relationCount).toBe(0);
    }
  });
  it("refuses a nonempty target by default without changing records, audit or files", async () => {
    const before = await state();
    const documentBefore = await readFile(path.join(stagingDir, DOCUMENT_KEY));
    const result = await stagedRestore({ archivePath, targetUrl: fixture!.url, stagingDir });
    expect(result).toMatchObject({ ok: false, readyForCutover: false, validationErrors: [], migrationsApplied: [], documentsRestored: 0 });
    expect(result.errors.join(" ")).toContain("الهدف ليس فارغًا");
    expect(await state()).toEqual(before);
    expect(await readFile(path.join(stagingDir, DOCUMENT_KEY))).toEqual(documentBefore);
    expect(vi.mocked(loadMigrationFiles)).toHaveBeenCalledTimes(1);
  });
});

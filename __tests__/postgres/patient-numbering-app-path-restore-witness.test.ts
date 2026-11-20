import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { validateGeneratedDatabaseName } from "../../scripts/verify-schema-ownership";

/**
 * Review witness (synthetic only): patient numbers are issued through the
 * application's own patient-create path before and after a full staged
 * restore. Raw nextval/allocator calls are not used as proof.
 */
const checked = validatePostgresTestTarget(process.env);
const tag = randomUUID().replaceAll("-", "").slice(0, 20);
const names = {
  source: `aqlan_schema_ownership_na_s_${tag}`,
  restored: `aqlan_schema_ownership_na_r_${tag}`,
  pending: `aqlan_schema_ownership_na_p_${tag}`,
};
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;
const owned = new Map<string, { oid: string; owner: string }>();
let directory: string;
let db: typeof import("../../lib/db");

const urlFor = (name: string) => { const url = new URL(checked.testUrl); url.pathname = `/${name}`; return url.toString(); };
async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: checked.maintenanceUrl.toString(), ssl: false });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}
async function createOwned(name: string) {
  validateGeneratedDatabaseName(name);
  if (name.length > 63) throw new Error("Synthetic database name exceeds the identifier limit");
  await admin(async client => {
    expect((await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [name])).rows).toEqual([]);
    await client.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    const identity = (await client.query<{ oid: string; owner: string }>(
      "SELECT oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1", [name])).rows[0];
    if (!identity) throw new Error("Synthetic database identity unavailable");
    owned.set(name, identity);
  });
}
/** Point the application module at an owned synthetic database and boot it like the app does. */
async function useDatabase(name: string) {
  if (!owned.has(name)) throw new Error("Only an owned synthetic database may be used");
  await db.resetPoolForTesting();
  process.env.DATABASE_URL = urlFor(name);
  process.env.TEST_DATABASE_URL = urlFor(name);
  db.schemaReadyReset();
  expect((await db.getPool().query("SELECT current_database() AS name")).rows[0].name).toBe(name);
  await db.ensureSchema();
}
const patient = (fullName: string) => ({
  fullName, phone: null, altPhone: null, gender: "unknown" as const, birthYear: null,
  address: null, medicalAlert: null, note: null,
});
const create = async (label: string) => (await db.createPatient(patient(label))).patientNumber;
const value = (number: string) => Number(number.slice(2));
async function sequenceState() {
  return (await db.getPool().query("SELECT last_value::text, is_called FROM patient_number_seq")).rows[0];
}
async function archiveCurrent(file: string) {
  const source = await db.getPool().connect();
  try {
    const { fullBackupBlocks } = await import("../../lib/fullBackup");
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source, readDocument: async () => { throw new Error("No documents may be read by this synthetic witness"); } })) blocks.push(block);
    const path = join(directory, file);
    await writeFile(path, gzipSync(Buffer.concat(blocks.map(block => Buffer.from(block)))));
    return path;
  } finally { source.release(); }
}
async function restoreInto(name: string, archivePath: string) {
  const { stagedRestore } = await import("../../lib/restore/staging");
  return stagedRestore({ archivePath, targetUrl: urlFor(name), stagingDir: join(directory, `${name}-documents`) });
}
async function numbersIn(name: string) {
  const client = new Client({ connectionString: urlFor(name), ssl: false });
  await client.connect();
  try { return (await client.query<{ patient_number: string }>("SELECT patient_number FROM patients ORDER BY id")).rows.map(row => row.patient_number); }
  finally { await client.end(); }
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "synthetic-numbering-app-path-"));
  for (const name of Object.values(names)) await createOwned(name);
  process.env.DATABASE_URL = urlFor(names.source);
  process.env.TEST_DATABASE_URL = urlFor(names.source);
  db = await import("../../lib/db");
  await useDatabase(names.source);
});

afterAll(async () => {
  const failures: unknown[] = [];
  try { await db?.resetPoolForTesting(); } catch (error) { failures.push(error); }
  for (const [name, identity] of owned) {
    try {
      await admin(async client => {
        const current = (await client.query("SELECT oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1", [name])).rows;
        if (current.length !== 1 || JSON.stringify(current[0]) !== JSON.stringify(identity)) throw new Error("Synthetic database identity changed; cleanup refused");
        await client.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      });
    } catch (error) { failures.push(error); }
  }
  try { if (directory) await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
  if (failures.length) throw new AggregateError(failures, "Synthetic app-path numbering witness cleanup failed");
});

it("issues unique numbers through patient create, survives staged restore without going back, and keeps old numbers", async () => {
  // A historical file number (pre-0080 style) stays exactly as stored.
  await db.getPool().query("INSERT INTO patients(patient_number, full_name) VALUES('P-00042', 'Synthetic prior file')");
  expect([await create("Synthetic A"), await create("Synthetic B"), await create("Synthetic C")]).toEqual(["P-07000", "P-07001", "P-07002"]);

  // Concurrent creation through the same application path: no duplicate, no gap reuse.
  const concurrent = await Promise.all(Array.from({ length: 24 }, (_, index) => create(`Synthetic concurrent ${index}`)));
  expect(new Set(concurrent).size).toBe(24);
  expect(concurrent.map(value).sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, index) => 7003 + index));

  // Restart does not move the counter backwards.
  db.schemaReadyReset(); await db.ensureSchema();
  expect(await create("Synthetic after restart")).toBe("P-07027");

  const archived = await numbersIn(names.source);
  const archivePath = await archiveCurrent("source.tar.gz");
  const archivedState = await sequenceState();
  expect(archivedState).toEqual({ last_value: "7027", is_called: true });

  // Numbers issued on the source after the archive was taken (external high water).
  const afterArchive = [await create("Synthetic after archive 1"), await create("Synthetic after archive 2")];
  expect(afterArchive).toEqual(["P-07028", "P-07029"]);

  const restored = await restoreInto(names.restored, archivePath);
  expect(restored).toMatchObject({
    ok: true, errors: [], validationErrors: [], readyForCutover: false,
    patientNumberSequence: "reconciled", cutoverBlocker: "numbering-freshness-unverified",
  });
  expect(await numbersIn(names.restored)).toEqual(archived);

  await useDatabase(names.restored);
  expect(await sequenceState()).toEqual(archivedState);
  const firstRestored = await create("Synthetic first after restore");
  // Never behind or equal to anything inside the archive …
  expect(value(firstRestored)).toBeGreaterThan(Math.max(...archived.map(value)));
  expect(archived).not.toContain(firstRestored);
  // … but an archive cannot know numbers issued after it was taken. This is
  // why the restore reports numbering-freshness-unverified and never cutover-ready.
  expect(firstRestored).toBe(afterArchive[0]);
  db.schemaReadyReset(); await db.ensureSchema();
  expect(await create("Synthetic second after restore")).toBe("P-07029");
  expect((await db.getPool().query("SELECT patient_number FROM patients WHERE full_name='Synthetic prior file'")).rows)
    .toEqual([{ patient_number: "P-00042" }]);
});

it("restores a pending (uncalled) counter and issues exactly that number next, then continues forward", async () => {
  await useDatabase(names.source);
  // A raised-but-unissued position, as Stage holds P-07000 pending: only setval, no issuance.
  await db.getPool().query("SELECT setval('patient_number_seq', 7100, false)");
  const archivePath = await archiveCurrent("pending.tar.gz");
  const restored = await restoreInto(names.pending, archivePath);
  expect(restored).toMatchObject({ ok: true, readyForCutover: false, patientNumberSequence: "reconciled" });
  await useDatabase(names.pending);
  expect(await sequenceState()).toEqual({ last_value: "7100", is_called: false });
  expect(await create("Synthetic pending first")).toBe("P-07100");
  db.schemaReadyReset(); await db.ensureSchema();
  expect(await create("Synthetic pending second")).toBe("P-07101");
  const all = await numbersIn(names.pending);
  expect(new Set(all).size).toBe(all.length);
});

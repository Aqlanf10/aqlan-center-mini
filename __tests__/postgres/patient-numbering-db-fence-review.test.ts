import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client, type QueryResult } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminClient, TEST_DATABASE_URL } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { PATIENT_NUMBER_SQL } from "../../lib/document-numbers";
import { redactPatientFileNumbers } from "../../lib/privacy/patient-file-number-redaction";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { sealSyntheticApplicationArchive, verifySyntheticApplicationArchive } from "../../scripts/review/patient-numbering-application-archive";

/** This is a PostgreSQL-only pilot. There is intentionally no mounted product settings
 * route, no fake owner/session, and no test integration that claims product activation. */
// Fail closed before cluster role creation; do not accept a DATABASE_URL fallback.
validatePostgresTestTarget();
const GROUPS = [
  "aqlan_numbering_data_owner", "aqlan_numbering_runtime", "aqlan_numbering_operator",
  "aqlan_numbering_app_fixture",
] as const;
const createdRoles: string[] = [];
const legacyInsert = `INSERT INTO public.patients(patient_number, full_name)
  VALUES (${PATIENT_NUMBER_SQL}, $1) RETURNING patient_number`;
const managedInsert = `INSERT INTO public.patients(patient_number, full_name)
  VALUES (NULL, $1) RETURNING patient_number`;
const policy = "SELECT numbering_review.set_managed_policy($1,$2,$3) AS revision";
const checkpoint = "SELECT * FROM numbering_review.inspect_checkpoint()";

let name = "", admin: Client;
const connections: Client[] = [];
const copiedDatabases: string[] = [];

async function roleSession(role: (typeof GROUPS)[number], database = name): Promise<Client> {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.toString(), ssl: false });
  connections.push(client);
  await client.connect();
  await client.query(`SET SESSION AUTHORIZATION ${role}`);
  return client;
}

const issued = async (c: Client, sql: string, label: string) =>
  (await c.query<{ patient_number: string }>(sql, [label])).rows[0].patient_number;

beforeAll(async () => {
  const client = adminClient("postgres");
  await client.connect();
  try {
    const matches = await client.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])", [GROUPS]);
    if (matches.rowCount !== 0) throw new Error("Synthetic numbering roles already exist; use an exclusive PG fixture.");
    for (const role of GROUPS) {
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
      createdRoles.push(role);
    }
    await client.query("GRANT aqlan_numbering_runtime TO aqlan_numbering_app_fixture");
  } finally { await client.end(); }
});

afterAll(async () => {
  const client = adminClient("postgres");
  await client.connect();
  try {
    for (const role of [...createdRoles].reverse()) await client.query(`DROP ROLE ${role}`);
  } finally { await client.end(); }
});

beforeEach(async () => {
  name = `aqlan_numbering_review_${randomUUID().replaceAll("-", "")}`;
  const maintenance = adminClient("postgres");
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE ${name}`); }
  finally { await maintenance.end(); }
  admin = adminClient(name);
  await admin.connect();
  connections.push(admin);
  await admin.query(`
    GRANT CREATE ON DATABASE ${name} TO aqlan_numbering_data_owner;
    GRANT CREATE ON SCHEMA public TO aqlan_numbering_data_owner;
    CREATE TABLE public.patients (
      id bigserial PRIMARY KEY,
      patient_number text NOT NULL UNIQUE,
      full_name text NOT NULL
    );
    CREATE SEQUENCE public.patient_number_seq;
    SELECT setval('public.patient_number_seq', 7000, false);
    INSERT INTO public.patients(patient_number,full_name)
      VALUES ('LEGACY-00042','SYNTHETIC ORIGINAL'), ('a-07009','SYNTHETIC OCCUPIED');
    ALTER TABLE public.patients OWNER TO aqlan_numbering_data_owner;
    ALTER SEQUENCE public.patient_number_seq OWNER TO aqlan_numbering_data_owner;
    GRANT USAGE,UPDATE,SELECT ON SEQUENCE public.patient_number_seq TO aqlan_numbering_runtime;
    GRANT SELECT,INSERT,UPDATE ON public.patients TO aqlan_numbering_runtime;
    GRANT USAGE ON SEQUENCE public.patients_id_seq TO aqlan_numbering_runtime;
  `);
  await admin.query(await readFile("scripts/review/patient-numbering-fence.pg18.sql", "utf8"));
  await admin.query(await readFile("scripts/review/patient-numbering-recovery.pg18.sql", "utf8"));
});

afterEach(async () => {
  for (const client of connections.splice(0)) await client.end().catch(() => undefined);
  if (!/^aqlan_numbering_review_[0-9a-f]{32}$/.test(name)) throw new Error("Unsafe review database name.");
  const maintenance = adminClient("postgres");
  await maintenance.connect();
  try {
    for (const database of [...copiedDatabases.splice(0), name]) {
      if (!/^aqlan_numbering_review_[0-9a-f]{32}$/.test(database)) throw new Error("Unsafe cleanup name.");
      await maintenance.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
  }
  finally { await maintenance.end(); }
});

async function copyCurrentDatabase(): Promise<string> {
  for (const client of connections.splice(0)) await client.end();
  const copy = `aqlan_numbering_review_${randomUUID().replaceAll("-", "")}`;
  const maintenance = adminClient("postgres");
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE ${copy} TEMPLATE ${name}`);
    copiedDatabases.push(copy);
  } finally { await maintenance.end(); }
  return copy;
}

describe("dormant database numbering boundary (no product enrollment or activation)", () => {
  it("installation is dormant: a normal legacy writer keeps P-07000, then P-07001 and existing numbers", async () => {
    const op = await roleSession("aqlan_numbering_operator");
    const runtime = await roleSession("aqlan_numbering_app_fixture");
    expect((await op.query(checkpoint)).rows[0]).toEqual({
      phase: "LEGACY", prefix: "P", revision: "1", last_value: "7000", is_called: false,
    });
    await expect(runtime.query(policy, [1, "A", 8000])).rejects.toMatchObject({ code: "42501" });
    await expect(issued(runtime, managedInsert, "UNMOUNTED")).rejects.toMatchObject({ code: "55000" });
    expect(await issued(runtime, legacyInsert, "SYNTHETIC ONE")).toBe("P-07000");
    expect(await issued(runtime, legacyInsert, "SYNTHETIC TWO")).toBe("P-07001");
    expect((await runtime.query("SELECT patient_number FROM public.patients ORDER BY id LIMIT 2")).rows).toEqual([
      { patient_number: "LEGACY-00042" }, { patient_number: "a-07009" },
    ]);
  });

  it("fences a warm left-over writer and its sequence privileges after the cutover commits", async () => {
    const op = await roleSession("aqlan_numbering_operator");
    const old = await roleSession("aqlan_numbering_app_fixture");
    const compatible = await roleSession("aqlan_numbering_app_fixture");
    await old.query("BEGIN");
    let activation: Promise<QueryResult<{ revision: string }>> | undefined;
    try {
      // One old INSERT has acquired the table's write lock; it belongs before cutover.
      expect(await issued(old, legacyInsert, "SYNTHETIC INFLIGHT")).toBe("P-07000");
      const { pid } = (await op.query<{ pid: number }>("SELECT pg_backend_pid() as pid")).rows[0];
      activation = op.query<{ revision: string }>(policy, [1, "A", 7000]);
      void activation.catch(() => undefined);
      let lockSeen = false;
      for (let i = 0; i < 100; i++) {
        const { blocked } = (await admin.query<{ blocked: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [pid],
        )).rows[0];
        if (blocked) { lockSeen = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(lockSeen).toBe(true);
    } finally { await old.query("COMMIT"); }
    expect((await activation!).rows[0]).toEqual({ revision: "2" });
    // Same connection and role that succeeded before. Legacy direct sequence and
    // explicit-number insertion are both fenced, not merely hidden by an app guard.
    await expect(issued(old, legacyInsert, "SYNTHETIC OLD")).rejects.toMatchObject({ code: "42501" });
    await expect(old.query("SELECT setval('public.patient_number_seq', 7000, false)")).rejects.toMatchObject({ code: "42501" });
    await expect(old.query(
      "INSERT INTO public.patients(patient_number,full_name) VALUES ('P-88888', 'SYNTHETIC EXPLICIT')",
    )).rejects.toMatchObject({ code: "55000" });
    expect(await issued(compatible, managedInsert, "SYNTHETIC COMPATIBLE")).toBe("A-07010");
    await expect(compatible.query(
      "UPDATE public.patients SET patient_number='A-08888' WHERE patient_number='LEGACY-00042'",
    )).rejects.toMatchObject({ code: "55000" });
    expect((await compatible.query("SELECT patient_number FROM public.patients ORDER BY id")).rows).toEqual([
      { patient_number: "LEGACY-00042" }, { patient_number: "a-07009" }, { patient_number: "P-07000" },
      { patient_number: "A-07010" },
    ]);
  });

  it("never silently cuts over while another grant can bypass the physical sequence fence", async () => {
    const op = await roleSession("aqlan_numbering_operator");
    const app = await roleSession("aqlan_numbering_app_fixture");
    await admin.query("GRANT USAGE ON SEQUENCE public.patient_number_seq TO aqlan_numbering_app_fixture");
    await expect(op.query(policy, [1, "A", 8000])).rejects.toMatchObject({ code: "55000" });
    expect((await op.query(checkpoint)).rows[0]).toEqual({
      phase: "LEGACY", prefix: "P", revision: "1", last_value: "7000", is_called: false,
    });
    expect(await issued(app, legacyInsert, "SYNTHETIC LEGACY")).toBe("P-07000");
  });

  it("keeps a rolled-back policy atomic, but never reissues a number consumed by a rolled-back patient", async () => {
    const op = await roleSession("aqlan_numbering_operator");
    const app = await roleSession("aqlan_numbering_app_fixture");
    await op.query("BEGIN");
    try {
      await op.query(policy, [1, "Z", 14000]);
    } finally { await op.query("ROLLBACK"); }
    expect(await issued(app, legacyInsert, "SYNTHETIC AFTER POLICY ROLLBACK")).toBe("P-07000");
    expect((await op.query(policy, [1, "Z", 9000])).rows[0].revision).toBe("2");
    await app.query("BEGIN");
    try { expect(await issued(app, managedInsert, "SYNTHETIC ABORTED")).toBe("Z-09000"); }
    finally { await app.query("ROLLBACK"); }
    await expect(op.query(policy, [1, "X", 7000])).rejects.toMatchObject({ code: "55000" });
    expect(await issued(app, managedInsert, "SYNTHETIC KEPT")).toBe("Z-09001");
    await op.query(policy, [2, "X", 7000]);
    expect(await issued(app, managedInsert, "SYNTHETIC OTHER PREFIX")).toBe("X-09002");
    await op.query(policy, [3, "Z", 7000]);
    expect(await issued(app, managedInsert, "SYNTHETIC SWITCH BACK")).toBe("Z-09003");
  });

  it("records actual sequence state, then holds both writers without fallback when recovery is unproven", async () => {
    const op = await roleSession("aqlan_numbering_operator");
    const app = await roleSession("aqlan_numbering_app_fixture");
    await op.query(policy, [1, "Z", 150000]);
    expect((await op.query(checkpoint)).rows[0]).toEqual({
      phase: "MANAGED", prefix: "Z", revision: "2", last_value: "150000", is_called: false,
    });
    expect(await issued(app, managedInsert, "SYNTHETIC SIX FIGURES")).toBe("Z-150000");
    await op.query("SELECT numbering_review.hold_issuance(2)");
    await expect(issued(app, managedInsert, "SYNTHETIC HOLD")).rejects.toMatchObject({ code: "55000" });
    await expect(issued(app, legacyInsert, "SYNTHETIC OLD HOLD")).rejects.toMatchObject({ code: "42501" });
    await expect(op.query(policy, [3, "Z", 7000])).rejects.toMatchObject({ code: "55000" });
    expect((await op.query(checkpoint)).rows[0]).toEqual({
      phase: "RECOVERY_HOLD", prefix: "Z", revision: "3", last_value: "150000", is_called: true,
    });
    expect((await app.query("SELECT count(*)::int AS total FROM public.patients")).rows[0].total).toBe(3);
  });

  it("a cloned database keeps the archived state but cannot become live by itself", async () => {
    const op = await roleSession("aqlan_numbering_operator");
    const app = await roleSession("aqlan_numbering_app_fixture");
    await op.query(policy, [1, "Z", 160000]);
    await app.query("BEGIN");
    try { expect(await issued(app, managedInsert, "SYNTHETIC BURNED")).toBe("Z-160000"); }
    finally { await app.query("ROLLBACK"); }
    const copy = await copyCurrentDatabase();
    const copiedOp = await roleSession("aqlan_numbering_operator", copy);
    const copiedApp = await roleSession("aqlan_numbering_app_fixture", copy);
    expect((await copiedOp.query(checkpoint)).rows[0]).toEqual({
      phase: "RECOVERY_HOLD", prefix: "Z", revision: "2", last_value: "160000", is_called: true,
    });
    await expect(issued(copiedApp, managedInsert, "SYNTHETIC COPIED")).rejects.toMatchObject({ code: "55000" });
    await expect(copiedOp.query(policy, [2, "Z", 7000])).rejects.toMatchObject({ code: "55000" });
    const liveApp = await roleSession("aqlan_numbering_app_fixture");
    expect(await issued(liveApp, managedInsert, "SYNTHETIC SOURCE CONTINUES")).toBe("Z-160001");
  });

  it.each([false, true])("resumes only the independently approved held target (burned=%s)", async (consumed) => {
    const op = await roleSession("aqlan_numbering_operator");
    const app = await roleSession("aqlan_numbering_app_fixture");
    const owner = await roleSession("aqlan_numbering_data_owner");
    const capture = "SELECT numbering_review.capture_recovery_witness() AS evidence";
    const resume = "SELECT numbering_review.resume_approved_fixture($1,$2) AS revision";
    await expect(owner.query(capture)).rejects.toMatchObject({ code: "55000" });
    expect(await issued(app, legacyInsert, "SYNTHETIC PRESERVED P")).toBe("P-07000");
    await op.query(policy, [1, "R", 170000]);
    if (consumed) {
      await app.query("BEGIN");
      try { expect(await issued(app, managedInsert, "SYNTHETIC BURNED BUT NEVER STORED")).toBe("R-170000"); }
      finally { await app.query("ROLLBACK"); }
    }
    const mapping = (await app.query("SELECT id, patient_number FROM public.patients ORDER BY id")).rows;
    await op.query("SELECT numbering_review.hold_issuance(2)");
    await expect(op.query(capture)).rejects.toMatchObject({ code: "42501" });
    const { evidence } = (await owner.query(capture)).rows[0];
    expect(evidence).toMatchObject({ revision: "3", prefix: "R", isCalled: consumed, lastValue: "170000" });
    await expect(owner.query(resume, [evidence, evidence.binding])).rejects.toMatchObject({ code: "55000" });

    const copy = await copyCurrentDatabase();
    const restoredOwner = await roleSession("aqlan_numbering_data_owner", copy);
    const restoredOp = await roleSession("aqlan_numbering_operator", copy);
    const restoredApp = await roleSession("aqlan_numbering_app_fixture", copy);
    const target = (await restoredOwner.query("SELECT numbering_review.local_database_binding() AS target")).rows[0].target;
    expect(target).not.toBe(evidence.binding);
    await expect(restoredOwner.query(capture)).rejects.toMatchObject({ code: "55000" });
    await expect(restoredOp.query(resume, [evidence, target])).rejects.toMatchObject({ code: "42501" });
    await expect(restoredOwner.query(resume, [evidence, evidence.binding])).rejects.toMatchObject({ code: "55000" });
    await expect(restoredOwner.query(resume, [{ ...evidence, isCalled: !consumed }, target]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(issued(restoredApp, managedInsert, "SYNTHETIC STILL HELD")).rejects.toMatchObject({ code: "55000" });

    // A changed historical map does not pass just because the sequence is exact.
    await restoredOwner.query("BEGIN");
    try {
      await restoredOwner.query("DELETE FROM public.patients WHERE patient_number='LEGACY-00042'");
      await expect(restoredOwner.query(resume, [evidence, target])).rejects.toMatchObject({ code: "55000" });
    } finally { await restoredOwner.query("ROLLBACK"); }

    // Rebinding the explicitly proved target is transactional and does not advance its sequence.
    await restoredOwner.query("BEGIN");
    try { expect((await restoredOwner.query(resume, [evidence, target])).rows[0].revision).toBe("4"); }
    finally { await restoredOwner.query("ROLLBACK"); }
    expect((await restoredOp.query(checkpoint)).rows[0]).toMatchObject({ phase: "RECOVERY_HOLD", revision: "3" });
    expect((await restoredOwner.query(resume, [evidence, target])).rows[0].revision).toBe("4");
    await expect(restoredOwner.query(resume, [evidence, target])).rejects.toMatchObject({ code: "55000" });
    expect((await restoredOp.query(checkpoint)).rows[0]).toEqual({
      phase: "MANAGED", prefix: "R", revision: "4", last_value: "170000", is_called: consumed,
    });
    expect((await restoredApp.query("SELECT id, patient_number FROM public.patients ORDER BY id")).rows).toEqual(mapping);
    await expect(issued(restoredApp, legacyInsert, "SYNTHETIC OLD STILL DENIED")).rejects.toMatchObject({ code: "42501" });
    expect(await issued(restoredApp, managedInsert, "SYNTHETIC RESTORED NEXT")).toBe(consumed ? "R-170001" : "R-170000");
    const originalApp = await roleSession("aqlan_numbering_app_fixture");
    await expect(issued(originalApp, managedInsert, "SYNTHETIC OLD SOURCE")).rejects.toMatchObject({ code: "55000" });
  });

  it.each([false, true])("round-trips app archive plus detached witness (burned=%s)", async (consumed) => {
    await admin.query(`
      CREATE TABLE public.settings (key text PRIMARY KEY, value text NOT NULL);
      CREATE TABLE public.patient_documents (id serial PRIMARY KEY, storage_key text, sha256 text, size_bytes bigint);
    `);
    const op = await roleSession("aqlan_numbering_operator");
    const app = await roleSession("aqlan_numbering_app_fixture");
    const owner = await roleSession("aqlan_numbering_data_owner");
    const capture = "SELECT numbering_review.capture_recovery_witness() AS evidence";
    const map = "SELECT id::text,patient_number FROM public.patients ORDER BY id";
    expect(await issued(app, legacyInsert, "SYNTHETIC STAYS LEGACY")).toBe("P-07000");
    await op.query(policy, [1, "A", 180000]);
    if (consumed) {
      await app.query("BEGIN");
      try { expect(await issued(app, managedInsert, "SYNTHETIC BURNED")).toBe("A-180000"); }
      finally { await app.query("ROLLBACK"); }
    }
    await op.query("SELECT numbering_review.hold_issuance(2)");
    const expectedMap = (await app.query(map)).rows;
    const before = (await owner.query(capture)).rows[0].evidence;
    const blocks: Uint8Array[] = [];
    for await (const chunk of fullBackupBlocks({ source: admin })) blocks.push(chunk);
    const archive = gzipSync(Buffer.concat(blocks));
    const after = (await owner.query(capture)).rows[0].evidence;
    expect(verifySyntheticApplicationArchive(archive)).toEqual({ kind: "legacy-data-only", management: "held" });
    expect(sealSyntheticApplicationArchive(archive, before, { ...after, isCalled: !consumed })).toBeNull();
    const detached = sealSyntheticApplicationArchive(archive, before, after);
    expect(detached).not.toBeNull();
    const verified = verifySyntheticApplicationArchive(archive, {
      bytes: detached!.bytes, expectedSidecarSha256: detached!.sha256,
    });
    expect(verified).toEqual({ kind: "recovery-candidate", management: "held", witness: before });
    if (verified.kind !== "recovery-candidate") throw new Error("Invalid synthetic archive evidence");

    const target = `aqlan_numbering_review_${randomUUID().replaceAll("-", "")}`;
    const maintenance = adminClient("postgres");
    await maintenance.connect();
    try {
      await maintenance.query(`CREATE DATABASE ${target}`);
      copiedDatabases.push(target);
    } finally { await maintenance.end(); }
    const url = new URL(TEST_DATABASE_URL); url.pathname = `/${target}`;
    const stage = await mkdtemp(join(tmpdir(), "numbering-review-app-archive-"));
    try {
      const archivePath = join(stage, "fixture.tar.gz");
      await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
      const result = await stagedRestore({ archivePath, targetUrl: url.toString(), stagingDir: join(stage, "docs") });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    } finally { await rm(stage, { recursive: true, force: true }); }

    // Existing app restore decodes patients unchanged, with no standalone sequence
    // or authority installation. The optional review adapter starts with no app access.
    const restoredAdmin = adminClient(target);
    await restoredAdmin.connect(); connections.push(restoredAdmin);
    expect((await restoredAdmin.query(map)).rows).toEqual(expectedMap);
    expect((await restoredAdmin.query("SELECT last_value::text,is_called FROM public.patient_number_seq")).rows)
      .toEqual([{ last_value: "1", is_called: true }]);
    await restoredAdmin.query(`
      GRANT CREATE ON DATABASE ${target} TO aqlan_numbering_data_owner;
      GRANT CREATE ON SCHEMA public TO aqlan_numbering_data_owner;
      ALTER TABLE public.patients OWNER TO aqlan_numbering_data_owner;
      ALTER SEQUENCE public.patient_number_seq OWNER TO aqlan_numbering_data_owner;
    `);
    for (const file of ["patient-numbering-fence.pg18.sql", "patient-numbering-recovery.pg18.sql",
      "patient-numbering-application-archive.pg18.sql"]) {
      await restoredAdmin.query(await readFile(`scripts/review/${file}`, "utf8"));
    }

    const restoredOwner = await roleSession("aqlan_numbering_data_owner", target);
    const restoredOp = await roleSession("aqlan_numbering_operator", target);
    const { binding: targetBinding } = (await restoredOwner.query("SELECT numbering_review.local_database_binding() AS binding")).rows[0];
    const prepare = "SELECT numbering_review.prepare_application_archive_fixture($1,$2) AS revision";
    const resume = "SELECT numbering_review.resume_approved_fixture($1,$2) AS revision";
    await expect(restoredOp.query(prepare, [verified.witness, targetBinding])).rejects.toMatchObject({ code: "42501" });
    await expect(restoredOwner.query(prepare, [verified.witness, before.binding])).rejects.toMatchObject({ code: "55000" });
    await expect(restoredOwner.query(prepare, [{ ...verified.witness, syntheticNumberMapSha256: "0".repeat(64) }, targetBinding]))
      .rejects.toMatchObject({ code: "55000" });
    await restoredOwner.query("BEGIN");
    try { expect((await restoredOwner.query(prepare, [verified.witness, targetBinding])).rows[0].revision).toBe("3"); }
    finally { await restoredOwner.query("ROLLBACK"); }
    expect((await restoredOp.query(checkpoint)).rows[0])
      .toEqual({ phase: "LEGACY", prefix: "P", revision: "1", last_value: "1", is_called: true });
    expect((await restoredOwner.query(prepare, [verified.witness, targetBinding])).rows[0].revision).toBe("3");
    expect((await restoredOp.query(checkpoint)).rows[0])
      .toEqual({ phase: "RECOVERY_HOLD", prefix: "A", revision: "3", last_value: "180000", is_called: consumed });
    // Enable only the isolated fixture's ordinary row accesses. Management stays held.
    await restoredAdmin.query(`
      GRANT SELECT,INSERT,UPDATE ON public.patients TO aqlan_numbering_runtime;
      GRANT USAGE ON SEQUENCE public.patients_id_seq TO aqlan_numbering_runtime;
    `);
    const restoredApp = await roleSession("aqlan_numbering_app_fixture", target);
    await expect(issued(restoredApp, managedInsert, "SYNTHETIC HELD")).rejects.toMatchObject({ code: "55000" });
    expect((await restoredOwner.query(resume, [verified.witness, targetBinding])).rows[0].revision).toBe("4");
    expect((await restoredApp.query(map)).rows).toEqual(expectedMap);
    const next = await issued(restoredApp, managedInsert, "SYNTHETIC NEXT");
    expect(next).toBe(consumed ? "A-180001" : "A-180000");

    // Cross-slice witness: classify exact persisted file numbers from the
    // recovered synthetic DB, without treating a whole prefix as patient-only.
    const sample = `historical LEGACY-00042, previously issued P-07000, file ${next}, receipt A-199999.`;
    const redacted = await redactPatientFileNumbers(sample, {
      historicalNumbers: expectedMap.map((row: { patient_number: string }) => row.patient_number),
      classify: async (candidates) => {
        const { rows } = await restoredApp.query<{ patient_number: string }>(
          "SELECT patient_number FROM public.patients WHERE patient_number = ANY($1::text[])", [candidates],
        );
        const patients = new Set(rows.map((row) => row.patient_number));
        return candidates.map((number) => ({ number, kind: patients.has(number) ? "patient" : "not-patient" }));
      },
    });
    expect(redacted).toEqual({
      ok: true, text: "historical [ملف محمي], previously issued [ملف محمي], file [ملف محمي], receipt A-199999.",
    });
    expect(await redactPatientFileNumbers(sample, {
      historicalNumbers: [],
      classify: async () => [],
    })).toEqual({ ok: false, reason: "unverified" });
  });
});

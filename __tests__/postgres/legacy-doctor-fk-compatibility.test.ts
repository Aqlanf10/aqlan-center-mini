import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as db from "../../lib/db";
import { runBaselineSchemaProbe } from "../../lib/baseline-probe";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { projectDetailedSchemaReadOnly } from "../../lib/schema-manifest";
import {
  assertPostgres18VersionNum,
  initializeGeneratedRuntimeSchema,
  validateGeneratedDatabaseName,
  validateOwnershipHarnessEnvironment,
  type OwnershipHarnessTarget,
} from "../../scripts/verify-schema-ownership";

const paths = ["fresh_runtime", "fresh_numbered", "legacy_no_action"] as const;
const expectedSetNull = "FOREIGN KEY (doctor_id) REFERENCES parties(id) ON DELETE SET NULL";

// Frozen, synthetic predecessor: only the original base tables and default-action FK.
// Do not manufacture this path by replacing the FK after current startup has run.
const legacyFixtureSql = `
  CREATE TABLE parties (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'supplier', phone TEXT, note TEXT,
    commission_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE visits (
    id SERIAL PRIMARY KEY, patient_name TEXT NOT NULL, patient_phone TEXT, note TEXT,
    status TEXT NOT NULL DEFAULT 'waiting', chair INTEGER,
    arrived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    seated_at TIMESTAMPTZ, finished_at TIMESTAMPTZ
  );
  ALTER TABLE visits ADD COLUMN doctor_id INTEGER REFERENCES parties(id);
`;

async function doctorFk(client: Client) {
  const { rows } = await client.query<{
    oid: string; action: string; definition: string;
    validated: boolean; deferrable: boolean; deferred: boolean;
  }>(`
    SELECT oid::text, confdeltype AS action, pg_get_constraintdef(oid) AS definition,
           convalidated AS validated, condeferrable AS deferrable, condeferred AS deferred
    FROM pg_constraint
    WHERE conrelid = 'public.visits'::regclass
      AND conname = 'visits_doctor_id_fkey' AND contype = 'f'
  `);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function insertRawDoctorVisit(client: Client) {
  const { rows: [doctor] } = await client.query<{ id: number }>(
    "INSERT INTO parties (name, kind) VALUES ('Synthetic FK doctor', 'doctor') RETURNING id",
  );
  const { rows: [visit] } = await client.query<{ id: number }>(
    "INSERT INTO visits (patient_name, doctor_id) VALUES ('Synthetic FK visit', $1) RETURNING id",
    [doctor.id],
  );
  return { doctorId: doctor.id, visitId: visit.id };
}

async function visitAttribution(client: Client, visitId: number) {
  const { rows } = await client.query(
    "SELECT id, patient_name, doctor_id FROM visits WHERE id = $1", [visitId],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe.each(paths)("PG18 visit-doctor FK compatibility: %s", (path) => {
  const name = `aqlan_schema_ownership_fk_${path}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  let target: OwnershipHarnessTarget;
  let admin: Client | undefined;
  let client: Client;
  let pool: Pool;
  let created = false;
  let adminConnected = false;
  let files: Awaited<ReturnType<typeof loadMigrationFiles>>;
  let initialFk: Awaited<ReturnType<typeof doctorFk>>;
  let startupFixture: Awaited<ReturnType<typeof insertRawDoctorVisit>>;
  let initialAttribution: Awaited<ReturnType<typeof visitAttribution>>;

  beforeAll(async () => {
    // Validate BEFORE stubbing environment or creating anything. Never scrub Railway
    // markers to make an unsafe target look like a disposable local database.
    target = validateOwnershipHarnessEnvironment(process.env);
    validateGeneratedDatabaseName(name);
    admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
    await admin.connect();
    adminConnected = true;
    const { rows: [server] } = await admin.query<{ version: string }>(
      "SELECT current_setting('server_version_num') AS version",
    );
    assertPostgres18VersionNum(server.version);
    // Unique generated name: no DROP-before-CREATE that could destroy someone else's fixture.
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(target.testUrl);
    url.pathname = `/${name}`;
    client = new Client({ connectionString: url.toString(), ssl: false });
    pool = new Pool({ connectionString: url.toString(), ssl: false });
    await client.connect();
    files = await loadMigrationFiles();

    await db.resetPoolForTesting();
    vi.stubEnv("DATABASE_URL", url.toString());
    for (const key of ["POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING", "USE_LOCAL_DB"]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_ENVIRONMENT", "test");
    vi.stubEnv("SKIP_SEED", "true");

    if (path === "legacy_no_action") {
      await client.query(legacyFixtureSql);
      startupFixture = await insertRawDoctorVisit(client);
      initialFk = await doctorFk(client);
      initialAttribution = await visitAttribution(client, startupFixture.visitId);
      await initializeGeneratedRuntimeSchema(target, name);
      expect(await doctorFk(client)).toEqual(initialFk);
      expect(await visitAttribution(client, startupFixture.visitId)).toEqual(initialAttribution);
    } else {
      if (path === "fresh_numbered") {
        const result = await migrate(pool as unknown as db.DbPool, { apply: true, files });
        expect(result.adoptedBaseline).toBe(false);
        expect(result.appliedVersions).toEqual(files.map((file) => file.version));
      } else {
        await initializeGeneratedRuntimeSchema(target, name);
      }
      startupFixture = await insertRawDoctorVisit(client);
      initialFk = await doctorFk(client);
      initialAttribution = await visitAttribution(client, startupFixture.visitId);
    }
    expect(initialFk).toMatchObject({
      action: path === "legacy_no_action" ? "a" : "n",
      definition: path === "legacy_no_action"
        ? "FOREIGN KEY (doctor_id) REFERENCES parties(id)" : expectedSetNull,
      validated: true, deferrable: false, deferred: false,
    });
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    // Attempt every cleanup even if setup, an assertion, or closing a pool failed.
    for (const close of [
      () => db.resetPoolForTesting(),
      () => pool?.end(),
      () => client?.end(),
    ]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    vi.unstubAllEnvs();
    try {
      if (created && adminConnected) {
        validateGeneratedDatabaseName(name);
        await admin!.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        expect((await admin!.query("SELECT datname FROM pg_database WHERE datname = $1", [name])).rows).toEqual([]);
      }
    } catch (error) { failures.push(error); }
    try { await admin?.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Doctor FK synthetic database cleanup failed");
  });

  it("preserves the populated FK identity and visit attribution across repeated cold starts", async () => {
    for (let restart = 0; restart < 2; restart += 1) {
      await initializeGeneratedRuntimeSchema(target, name);
      expect(await doctorFk(client)).toEqual(initialFk);
      expect(await visitAttribution(client, startupFixture.visitId)).toEqual(initialAttribution);
    }
  });

  it("preserves attribution and commission history through supported party/account lifecycle operations", async () => {
    const doctor = await db.createParty({
      name: "Synthetic application doctor", kind: "doctor", phone: null,
      commissionPercent: 20, note: null,
    });
    const { rows: [visit] } = await client.query<{ id: number }>(
      "INSERT INTO visits (patient_name, doctor_id) VALUES ('Synthetic lifecycle visit', $1) RETURNING id",
      [doctor.id],
    );
    const { rows: [user] } = await client.query<{ id: number }>(
      `INSERT INTO users (username, display_name, password_hash, role, party_id)
       VALUES ('synthetic_fk_account', 'Synthetic account', 'not-a-login-hash', 'doctor', $1) RETURNING id`,
      [doctor.id],
    );
    const attribution = await visitAttribution(client, visit.id);
    const history = async () => (await client.query(
      "SELECT * FROM doctor_commission_history WHERE party_id = $1 ORDER BY id", [doctor.id],
    )).rows;
    const originalHistory = await history();
    expect(originalHistory).toHaveLength(1);
    const preserved = async () => {
      expect(await visitAttribution(client, visit.id)).toEqual(attribution);
      expect(await history()).toEqual(originalHistory);
    };

    expect((await db.updateParty(doctor.id, { isActive: false }))?.isActive).toBe(false);
    await preserved();
    expect((await client.query("SELECT party_id, is_active FROM users WHERE id = $1", [user.id])).rows)
      .toEqual([{ party_id: doctor.id, is_active: true }]);
    expect(await db.findUserByUsername("synthetic_fk_account")).not.toBeNull();
    expect(await db.linkUserDoctor(user.id, doctor.id)).toBeNull();
    expect((await client.query("SELECT party_id FROM users WHERE id = $1", [user.id])).rows)
      .toEqual([{ party_id: doctor.id }]);
    await preserved();

    expect((await db.updateParty(doctor.id, { isActive: true }))?.isActive).toBe(true);
    await preserved();
    expect((await db.linkUserDoctor(user.id, null))?.partyId).toBeNull();
    await preserved();
    expect((await db.linkUserDoctor(user.id, doctor.id))?.partyId).toBe(doctor.id);
    await preserved();
    expect(await db.updateUser(user.id, { isActive: false })).toMatchObject({ isActive: false, partyId: doctor.id });
    expect(await db.findUserByUsername("synthetic_fk_account")).toBeNull();
    expect((await db.getParty(doctor.id))?.isActive).toBe(true);
    await preserved();
    expect(await db.updateUser(user.id, { isActive: true })).toMatchObject({ isActive: true, partyId: doctor.id });
    expect(await db.findUserByUsername("synthetic_fk_account")).not.toBeNull();
    await preserved();

    // No doctor-delete API is under test. Raw deletion here proves the independent
    // append-only history barrier and rollback of any SET NULL action in the statement.
    await expect(client.query("DELETE FROM parties WHERE id = $1", [doctor.id])).rejects.toMatchObject({
      code: expect.stringMatching(/^(23503|23001)$/),
      constraint: expect.stringMatching(/^(visits_doctor_id_fkey|doctor_commission_history_party_id_fkey)$/),
    });
    expect(await db.getParty(doctor.id)).not.toBeNull();
    expect((await client.query("SELECT party_id, is_active FROM users WHERE id = $1", [user.id])).rows)
      .toEqual([{ party_id: doctor.id, is_active: true }]);
    await preserved();
    const historyOnly = await db.createParty({
      name: "Synthetic history-only doctor", kind: "doctor", phone: null, commissionPercent: 0, note: null,
    });
    await expect(client.query("DELETE FROM parties WHERE id = $1", [historyOnly.id])).rejects.toMatchObject({
      code: expect.stringMatching(/^(23503|23001)$/), constraint: "doctor_commission_history_party_id_fkey",
    });
    expect(await db.getParty(historyOnly.id)).not.toBeNull();
    expect(await doctorFk(client)).toEqual(initialFk);
  });

  it("rejects orphans and isolates the different synthetic hard-delete semantics", async () => {
    // Deliberately bypass createParty AFTER startup: its commission-history FK would
    // mask the visits FK. These disposable rows do not model an application deletion.
    const fixture = await insertRawDoctorVisit(client);
    const original = await visitAttribution(client, fixture.visitId);
    await expect(client.query(
      "UPDATE visits SET doctor_id = 2147483647 WHERE id = $1", [fixture.visitId],
    )).rejects.toMatchObject({ code: "23503", constraint: "visits_doctor_id_fkey" });
    expect(await visitAttribution(client, fixture.visitId)).toEqual(original);
    await client.query("UPDATE visits SET doctor_id = NULL WHERE id = $1", [fixture.visitId]);
    expect((await visitAttribution(client, fixture.visitId)).doctor_id).toBeNull();
    await client.query("UPDATE visits SET doctor_id = $1 WHERE id = $2", [fixture.doctorId, fixture.visitId]);
    expect(await visitAttribution(client, fixture.visitId)).toEqual(original);

    if (path === "legacy_no_action") {
      await expect(client.query("DELETE FROM parties WHERE id = $1", [fixture.doctorId]))
        .rejects.toMatchObject({ code: "23503", constraint: "visits_doctor_id_fkey" });
      expect(await visitAttribution(client, fixture.visitId)).toEqual(original);
    } else {
      expect((await client.query("DELETE FROM parties WHERE id = $1", [fixture.doctorId])).rowCount).toBe(1);
      expect(await visitAttribution(client, fixture.visitId)).toEqual({ ...original, doctor_id: null });
    }
    expect(await doctorFk(client)).toEqual(initialFk);
  });

  it("keeps the baseline probe action-sensitive and leaves schema, registry, and rows unchanged", async () => {
    const before = await projectDetailedSchemaReadOnly(client);
    const rowsBefore = async () => ({
      visits: (await client.query("SELECT * FROM visits ORDER BY id")).rows,
      parties: (await client.query("SELECT * FROM parties ORDER BY id")).rows,
      users: (await client.query("SELECT * FROM users ORDER BY id")).rows,
      history: (await client.query("SELECT * FROM doctor_commission_history ORDER BY id")).rows,
    });
    const originalRows = await rowsBefore();
    const probe = await runBaselineSchemaProbe(pool as unknown as db.DbPool, files[0].sql);
    expect(probe.ok).toBe(path !== "legacy_no_action");
    expect(probe.missingTables).toEqual([]);
    expect(probe.columnProblems).toEqual([]);
    expect(probe.missingIndexes).toEqual([]);
    expect(probe.missingTriggers).toEqual([]);
    expect(probe.missingConstraints).toEqual(path === "legacy_no_action" ? [`visits|${expectedSetNull}`] : []);

    if (path === "legacy_no_action") {
      await expect(migrate(pool as unknown as db.DbPool, { apply: false, files }))
        .rejects.toThrow("BASELINE_SCHEMA_MISMATCH");
    } else {
      await expect(migrate(pool as unknown as db.DbPool, { apply: false, files })).resolves.toBeDefined();
    }
    expect(await projectDetailedSchemaReadOnly(client)).toEqual(before);
    expect(await rowsBefore()).toEqual(originalRows);
    expect(await doctorFk(client)).toEqual(initialFk);
    expect((await client.query("SELECT to_regclass('public.schema_migrations') IS NULL AS absent")).rows)
      .toEqual([{ absent: path !== "fresh_numbered" }]);
    expect((await client.query(
      "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'aqlan_baseline_probe%'",
    )).rows).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbClient, DbPool } from "../../lib/db";
import { ensureSchemaMigrationsTable, loadMigrationFiles, migrate } from "../../lib/migrations";
import { ORTHO_TREATMENT_STRATEGY_SQL } from "../../lib/ortho-treatment-strategy-schema";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { assertReviewedMigrationChain, expectedMigrationRegistry, LATEST_REVIEWED_MIGRATION_VERSION, migrationFilesThrough } from "./_reviewed-migration-chain";

// Source-only test preparation. Uses the existing owned fresh-UUID PG18 harness
// in pristine mode, never a pre-existing application database or its reset path.
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
const pool = () => fixture!.pool;
let sequence = 0;
type Scope = { patient: number; ortho: number; clinical: number; actor: number };
let old: Scope;
let oldFacts: unknown;
let shippedFiles: Awaited<ReturnType<typeof loadMigrationFiles>>;
async function seedScope(db: DbPool | DbClient): Promise<Scope> {
  const n = ++sequence;
  const { rows: [patient] } = await db.query<{ id: number }>("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic strategy patient') RETURNING id", [`SYN-STRATEGY-${n}`]);
  const { rows: [actor] } = await db.query<{ id: number }>("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic clinician','fixture-unused','doctor') RETURNING id", [`synthetic-strategy-${n}`]);
  const { rows: [ortho] } = await db.query<{ id: number }>("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id", [patient.id]);
  const { rows: [clinical] } = await db.query<{ id: number }>("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic linked case',$2,'synthetic') RETURNING id", [patient.id, ortho.id]);
  return { patient: patient.id, ortho: ortho.id, clinical: clinical.id, actor: actor.id };
}
async function facts(db: DbPool | DbClient, scope: Scope) {
  return (await db.query(`SELECT to_jsonb(o) AS ortho, to_jsonb(c) AS clinical,
    (SELECT COUNT(*) FROM visits) AS visits, (SELECT COUNT(*) FROM visit_procedures) AS procedures,
    (SELECT COUNT(*) FROM treatment_plans) AS plans, (SELECT COUNT(*) FROM plan_items) AS items,
    (SELECT COUNT(*) FROM invoices) AS invoices, (SELECT COUNT(*) FROM payments) AS payments
    FROM ortho_cases o JOIN clinical_cases c ON c.ortho_case_id=o.id WHERE o.id=$1`, [scope.ortho])).rows;
}
async function insert(db: DbPool | DbClient, scope: Scope, options: {
  id?: number; version?: number; predecessor?: number | null; command?: string; actor?: number;
} = {}) {
  const { rows: [saved] } = await db.query<{ id: number }>(`INSERT INTO ortho_strategy_revisions
    (id,patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,supersedes_revision_id,actor_user_id,
     created_by,reason,recording_context,command_id,request_fingerprint,rows)
    VALUES(COALESCE($1::int,nextval(pg_get_serial_sequence('ortho_strategy_revisions','id'))::int),
      $2,$2,$3,$4,$5,$6,$7,'Synthetic clinician','Explicit retrospective correction','retrospective',$8,$9,$10::jsonb) RETURNING id`,
  [options.id ?? null, scope.patient, scope.ortho, scope.clinical, options.version ?? 1, options.predecessor ?? null,
    options.actor ?? scope.actor, options.command ?? `synthetic-command-${++sequence}`, "a".repeat(64),
    JSON.stringify([{ problem: { id: 1, label: "Synthetic recorded problem", site: null }, objective: null, strategy: "Clinician-entered text", rationale: null, planItems: [] }])]);
  return saved.id;
}
beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  const all = await loadMigrationFiles();
  assertReviewedMigrationChain(all, LATEST_REVIEWED_MIGRATION_VERSION);
  shippedFiles = all;
  const baseline = migrationFilesThrough(all, "0043");
  expect(baseline).toHaveLength(43);
  expect(baseline.at(-1)?.filename).toBe("0043_legacy_treatment_coverage.sql");
  const strategy = all.filter(file => file.version === "0051");
  expect(strategy.map(file => file.filename)).toEqual(["0051_ortho_treatment_strategy.sql"]);
  // Include all reviewed predecessors of 0051 if the manifest is extended later;
  // never hide a shipped migration by constructing only [...baseline,...strategy].
  const predecessors = all.filter(file => file.version < "0051");
  await migrate(pool(), { apply: true, files: predecessors });
  expect((await pool().query("SELECT version,name,checksum,adopted FROM schema_migrations ORDER BY version")).rows)
    .toEqual(expectedMigrationRegistry(predecessors));
  old = await seedScope(pool()); oldFacts = await facts(pool(), old);
  expect(await migrate(pool(), { apply: true, files: all })).toMatchObject({
    appliedVersions: all.slice(predecessors.length).map(file => file.version),
  });
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

describe("reserved0051 append-only history on owned PostgreSQL18", () => {
  it("adds no inferred history and leaves old case and financial facts unchanged", async () => {
    expect((await pool().query("SELECT version,name,checksum,adopted FROM schema_migrations ORDER BY version")).rows)
      .toEqual(expectedMigrationRegistry(shippedFiles));
    expect(await facts(pool(), old)).toEqual(oldFacts);
    expect((await pool().query("SELECT * FROM ortho_strategy_revisions")).rows).toHaveLength(0);
    await pool().query(ORTHO_TREATMENT_STRATEGY_SQL); // Idempotent runtime bootstrap body.
    expect(await facts(pool(), old)).toEqual(oldFacts);
  });
  it("stores retrospective documentation without reopening or financial mutation, and refuses row rewriting", async () => {
    const scope = await seedScope(pool()); const before = await facts(pool(), scope);
    const revision = await insert(pool(), scope);
    expect(await facts(pool(), scope)).toEqual(before);
    expect((await pool().query("SELECT recording_context FROM ortho_strategy_revisions WHERE id=$1", [revision])).rows).toEqual([{ recording_context: "retrospective" }]);
    await expect(pool().query("UPDATE ortho_strategy_revisions SET reason='replacement' WHERE id=$1", [revision])).rejects.toMatchObject({ code: "55000" });
    await expect(pool().query("DELETE FROM ortho_strategy_revisions WHERE id=$1", [revision])).rejects.toMatchObject({ code: "55000" });
    await expect(pool().query("UPDATE ortho_strategy_revisions SET recorded_patient_id=999 WHERE id=$1", [revision])).rejects.toMatchObject({ code: "55000" });
  });
  it("enforces case version, stable-actor command and single-successor uniqueness", async () => {
    const scope = await seedScope(pool()); const first = await insert(pool(), scope, { command: "synthetic-fixed-command" });
    await expect(insert(pool(), scope)).rejects.toMatchObject({ code: "23505" });
    await expect(insert(pool(), scope, { version: 2, predecessor: first, command: "synthetic-fixed-command" })).rejects.toMatchObject({ code: "23505" });
    await pool().query("UPDATE users SET role='admin' WHERE id=$1", [scope.actor]);
    await expect(insert(pool(), scope, { version: 2, predecessor: first, command: "synthetic-fixed-command" })).rejects.toMatchObject({ code: "23505" });
    await insert(pool(), scope, { version: 2, predecessor: first });
    await expect(insert(pool(), scope, { version: 3, predecessor: first })).rejects.toMatchObject({ code: "23505" });
  });
  it("restores valid revisions in reverse order inside one transaction, then enforces final lineage", async () => {
    const scope = await seedScope(pool()); const client = await pool().connect();
    const { rows: ids } = await pool().query<{ id: number }>("SELECT nextval(pg_get_serial_sequence('ortho_strategy_revisions','id'))::int AS id FROM generate_series(1,2)");
    try {
      await client.query("BEGIN");
      await insert(client, scope, { id: ids[1].id, version: 2, predecessor: ids[0].id });
      await insert(client, scope, { id: ids[0].id });
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    expect((await pool().query("SELECT id,supersedes_revision_id FROM ortho_strategy_revisions WHERE ortho_case_id=$1 ORDER BY version", [scope.ortho])).rows)
      .toEqual([{ id: ids[0].id, supersedes_revision_id: null }, { id: ids[1].id, supersedes_revision_id: ids[0].id }]);
  });
  it.each(["orphan", "cross_case"])("rejects %s lineage at commit and rolls back the whole attempted document", async mode => {
    const scope = await seedScope(pool()); const other = await seedScope(pool());
    const predecessor = mode === "cross_case" ? await insert(pool(), other) : 2147483646;
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await insert(client, scope, { version: 2, predecessor });
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23503" });
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await pool().query("SELECT id FROM ortho_strategy_revisions WHERE ortho_case_id=$1", [scope.ortho])).rows).toHaveLength(0);
  });
  it.each(["skipped_version", "cycle"])("rejects %s history at commit even when same-case references exist", async mode => {
    const scope = await seedScope(pool()); const client = await pool().connect();
    const { rows: ids } = await pool().query<{ id: number }>("SELECT nextval(pg_get_serial_sequence('ortho_strategy_revisions','id'))::int AS id FROM generate_series(1,2)");
    try {
      await client.query("BEGIN");
      if (mode === "skipped_version") {
        await insert(client, scope, { id: ids[0].id });
        await insert(client, scope, { id: ids[1].id, version: 3, predecessor: ids[0].id });
      } else {
        await insert(client, scope, { id: ids[0].id, version: 2, predecessor: ids[1].id });
        await insert(client, scope, { id: ids[1].id, version: 3, predecessor: ids[0].id });
      }
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await pool().query("SELECT id FROM ortho_strategy_revisions WHERE ortho_case_id=$1", [scope.ortho])).rows).toHaveLength(0);
  });
  it("uses the actual canonical patient merge while retaining every historical clinical/provenance byte", async () => {
    await fixture!.db.ensureSchema();
    const scope = await seedScope(pool()); const revision = await insert(pool(), scope);
    const target = await seedScope(pool());
    const before = (await pool().query("SELECT to_jsonb(r)-'patient_id' AS history FROM ortho_strategy_revisions r WHERE id=$1", [revision])).rows;
    const merged = await fixture!.db.mergeDuplicatePatient(scope.patient, target.patient, { actor: "synthetic-admin", actorRole: "admin", reason: "Synthetic duplicate correction" });
    expect(merged.ok).toBe(true);
    expect((await pool().query("SELECT to_jsonb(r)-'patient_id' AS history FROM ortho_strategy_revisions r WHERE id=$1", [revision])).rows).toEqual(before);
    expect((await pool().query("SELECT patient_id,recorded_patient_id FROM ortho_strategy_revisions WHERE id=$1", [revision])).rows)
      .toEqual([{ patient_id: target.patient, recorded_patient_id: scope.patient }]);
    expect((await pool().query("SELECT id FROM patients WHERE id=$1", [scope.patient])).rows).toHaveLength(0);
    expect((await pool().query("SELECT patient_id FROM ortho_cases WHERE id=$1", [scope.ortho])).rows).toEqual([{ patient_id: target.patient }]);
    expect((await pool().query("SELECT patient_id FROM clinical_cases WHERE id=$1", [scope.clinical])).rows).toEqual([{ patient_id: target.patient }]);
    expect((await pool().query("SELECT action FROM audit_log WHERE action='patient.merge' AND entity_id=$1", [target.patient])).rows).toHaveLength(1);
  });
  it("defers owner validation across merge ordering but refuses a standalone owner substitution", async () => {
    const scope = await seedScope(pool()); const target = await seedScope(pool()); const revision = await insert(pool(), scope);
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE ortho_strategy_revisions SET patient_id=$1 WHERE id=$2", [target.patient, revision]);
      await expect(client.query("COMMIT")).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("UPDATE ortho_strategy_revisions SET patient_id=$1 WHERE id=$2", [target.patient, revision]);
      await client.query("UPDATE clinical_cases SET patient_id=$1 WHERE id=$2", [target.patient, scope.clinical]);
      await client.query("UPDATE ortho_cases SET patient_id=$1 WHERE id=$2", [target.patient, scope.ortho]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    expect((await pool().query("SELECT recorded_patient_id FROM ortho_strategy_revisions WHERE id=$1", [revision])).rows).toEqual([{ recorded_patient_id: scope.patient }]);
  });
  it("serializes an actual canonical merge behind the strategy patient lock, then transfers the committed history", async () => {
    const scope = await seedScope(pool()); const target = await seedScope(pool());
    const client = await pool().connect(); let merge: Promise<import("../../lib/db").PatientMergeResult> | undefined;
    let revision: number | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [scope.patient]);
      const { rows: [blocker] } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      merge = fixture!.db.mergeDuplicatePatient(scope.patient, target.patient, { actor: "synthetic-admin", reason: "Synthetic concurrent merge" });
      // Observe the actual PostgreSQL wait edge rather than inferring it from an
      // arbitrary sleep or an unresolved JS promise. This recreates the store's
      // patient lock; store authorization/commands are separately fixture-tested.
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const { rows: [state] } = await pool().query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked", [blocker.pid]);
        blocked = state.blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      revision = await insert(client, scope);
      await client.query("COMMIT");
      expect((await merge).ok).toBe(true);
    } finally {
      await client.query("ROLLBACK").catch(() => {}); client.release();
      await merge;
    }
    expect((await pool().query("SELECT patient_id,recorded_patient_id FROM ortho_strategy_revisions WHERE id=$1", [revision])).rows)
      .toEqual([{ patient_id: target.patient, recorded_patient_id: scope.patient }]);
  });
  it("includes history after its canonical owners in transaction-wrapped backup and resets its serial sequence", async () => {
    const scope = await seedScope(pool()); await insert(pool(), scope);
    const lines: string[] = []; for await (const line of fixture!.db.backupSnapshotSqlLines(pool())) lines.push(line);
    const sql = lines.join(""); const table = sql.indexOf("-- ortho_strategy_revisions (");
    expect(sql.indexOf("BEGIN;")).toBeLessThan(table); expect(sql.lastIndexOf("COMMIT;")).toBeGreaterThan(table);
    for (const owner of ["patients", "users", "ortho_cases", "clinical_cases"]) expect(sql.indexOf(`-- ${owner} (`)).toBeLessThan(table);
    expect(sql).toContain("ortho_strategy_revisions_id_seq");
    expect(sql.slice(table).split(/\n-- /)[0]).toContain("Explicit retrospective correction");
  });
  it("restores the actual backup after a merge without resurrecting the recorded source patient", async () => {
    // Last fixture use: the shared fresh-database harness deliberately drains
    // its prior runtime pool while switching to the second owned UUID database.
    const scope = await seedScope(pool()); const target = await seedScope(pool()); const revision = await insert(pool(), scope);
    expect((await fixture!.db.mergeDuplicatePatient(scope.patient, target.patient, { actor: "synthetic-admin", reason: "Synthetic restore provenance" })).ok).toBe(true);
    const before = (await pool().query("SELECT to_jsonb(r) AS history FROM ortho_strategy_revisions r WHERE id=$1", [revision])).rows;
    const lines: string[] = []; for await (const line of fixture!.db.backupSnapshotSqlLines(pool())) lines.push(line);
    const sql = lines.join(""); expect(sql).toContain("BEGIN;"); expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    const restored = await openPeriodontalFixture(process.env, { pristine: true });
    try {
      // Build the runtime schema only (SKIP_SEED=true is set by the owned harness).
      // There is no schema_migrations row to collide with the captured backup.
      await restored.db.ensureSchema();
      const registry = await restored.pool.connect();
      try { await ensureSchemaMigrationsTable(registry); } finally { registry.release(); }
      await restored.pool.query(sql);
      expect((await restored.pool.query("SELECT version,name,checksum,adopted FROM schema_migrations ORDER BY version")).rows)
        .toEqual(expectedMigrationRegistry(shippedFiles));
      expect((await restored.pool.query("SELECT to_jsonb(r) AS history FROM ortho_strategy_revisions r WHERE id=$1", [revision])).rows).toEqual(before);
      expect((await restored.pool.query("SELECT id FROM patients WHERE id=$1", [scope.patient])).rows).toHaveLength(0);
      expect((await restored.pool.query("SELECT patient_id,recorded_patient_id FROM ortho_strategy_revisions WHERE id=$1", [revision])).rows)
        .toEqual([{ patient_id: target.patient, recorded_patient_id: scope.patient }]);
    } finally { await restored.close(); }
  });
});

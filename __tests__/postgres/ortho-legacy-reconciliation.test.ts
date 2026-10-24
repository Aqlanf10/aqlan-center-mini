import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import runtime from "../../lib/ortho-assessment-runtime.generated.json";
import { ensureSchema, getPool, resetPoolForTesting } from "../../lib/db";
import { MIGRATION_ADVISORY_LOCK_KEY } from "../../lib/migrations";
import { applyOrthoAssessmentRuntime } from "../../lib/ortho-assessment-runtime";
import { reconcileOrthoStrategyLegacy, type ReconcileOptions } from "../../lib/ortho-legacy-reconciliation";

/* Synthetic only: explicit reconciliation of unregistered 0051 objects. The normal startup guard stays
 * fail closed; only an exact catalog match with valid existing rows and sequence can be registered, by an
 * explicit operator call, atomically, under the migration advisory lock. */
const NAME = /^aqlan_ortho_reconcile_[a-f0-9]{16}(_[a-z0-9]{1,24})?$/;
const keys = ["DATABASE_URL", "SKIP_SEED", "DB_POOL_MAX", "SESSION_SECRET"] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const owned: { name: string; oid: string; owner: string }[] = [];
const pools: Pool[] = [];
let admin: Client;
let target: ReturnType<typeof validatePostgresTestTarget>;
let base = "";
const [STRATEGY] = runtime;
const FUNCTIONS = ["reject_ortho_strategy_revision_mutation", "check_ortho_strategy_revision_final_state",
  "reject_ortho_assessment_revision_mutation", "check_ortho_assessment_revision_final_state"];

const urlFor = (name: string) => { const url = new URL(target.testUrl); url.pathname = `/${name}`; return url.toString(); };
async function createOwned(name: string, template: string) {
  if (!NAME.test(name)) throw new Error("Unexpected synthetic database name.");
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  const { rows: [identity] } = await admin.query("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [name]);
  if (!identity || identity.name !== name) throw new Error("Owned synthetic database identity unavailable.");
  owned.push(identity);
}
async function withClient<T>(name: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urlFor(name), ssl: false }); await client.connect();
  try { return await run(client); } finally { await client.end(); }
}
function poolFor(name: string) { const pool = new Pool({ connectionString: urlFor(name), ssl: false, max: 4 }); pools.push(pool); return pool; }
/** Everything a reconciliation could change, plus the preserved synthetic history. */
async function state(client: Client) {
  return {
    registry: (await client.query("SELECT version,name,checksum,adopted FROM schema_migrations ORDER BY version")).rows,
    audit: (await client.query("SELECT action,entity,entity_id,actor,details FROM audit_log WHERE action='schema.migration_reconciled' ORDER BY id")).rows,
    history: await client.query("SELECT to_regclass('public.ortho_strategy_revisions') IS NOT NULL AS e").then(async r => r.rows[0].e
      ? (await client.query("SELECT to_jsonb(r) AS row FROM ortho_strategy_revisions r ORDER BY id")).rows.map(row => row.row) : null),
    sequence: await client.query("SELECT to_regclass('public.ortho_strategy_revisions_id_seq') IS NOT NULL AS e").then(async r => r.rows[0].e
      ? (await client.query("SELECT last_value::text, is_called FROM ortho_strategy_revisions_id_seq")).rows[0] : null),
  };
}
/** Exact 0051 objects created directly (not registered) with three revisions of synthetic history. */
async function exactWithHistory(client: Client) {
  await client.query(STRATEGY.sql);
  const patient = (await client.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-ORTHO-REC','Synthetic ortho reconcile patient') RETURNING id")).rows[0].id;
  const ortho = (await client.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id", [patient])).rows[0].id;
  const clinical = (await client.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by,ortho_case_id) VALUES($1,'ortho','Synthetic case','synthetic',$2) RETURNING id", [patient, ortho])).rows[0].id;
  const user = (await client.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic_ortho_rec','Synthetic','not-a-login-hash','admin') RETURNING id")).rows[0].id;
  await client.query("BEGIN");
  let previous: number | null = null;
  for (const version of [1, 2, 3]) {
    previous = (await client.query(`INSERT INTO ortho_strategy_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,supersedes_revision_id,
      actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,rows)
      VALUES($1,$1,$2,$3,$4,$5,$6,'synthetic','Synthetic strategy revision','current',$7,$8,'[{"synthetic":true}]') RETURNING id`,
      [patient, ortho, clinical, version, previous, user, `synthetic-command-${version}-0000`, "a".repeat(64)])).rows[0].id;
  }
  await client.query("COMMIT");
  return { patient, ortho, clinical, user };
}
let scenarioCount = 0;
async function scenario(suffix: string, setup: (client: Client) => Promise<unknown>) {
  const name = `${base}_${suffix.slice(0, 18)}${++scenarioCount}`;
  await createOwned(name, base);
  await withClient(name, setup);
  return { name, pool: poolFor(name), before: await withClient(name, state) };
}
const options = (name: string, extra: Partial<ReconcileOptions> = {}): ReconcileOptions => ({ apply: false, expectedDatabase: name, ...extra });

beforeAll(async () => {
  target = validatePostgresTestTarget(process.env);
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false }); await admin.connect();
  process.env.SKIP_SEED = "true"; process.env.DB_POOL_MAX = "2"; process.env.SESSION_SECRET = "synthetic-ortho-reconcile-secret-0123456789";
  base = `aqlan_ortho_reconcile_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await createOwned(base, "template0");
  process.env.DATABASE_URL = urlFor(base); await resetPoolForTesting(); await ensureSchema(); await getPool().query("SELECT 1"); await resetPoolForTesting();
  // Predecessor: the candidate schema without the 0051/0052 objects and registry rows.
  await withClient(base, async client => {
    await client.query("DELETE FROM schema_migrations WHERE version IN ('0051','0052')");
    await client.query("DROP TABLE ortho_assessment_revisions"); await client.query("DROP TABLE ortho_strategy_revisions");
    for (const fn of FUNCTIONS) await client.query(`DROP FUNCTION ${fn}()`);
  });
}, 120_000);
afterAll(async () => {
  try {
    for (const pool of pools) await pool.end().catch(() => {});
    await resetPoolForTesting();
    for (const database of [...owned].reverse()) {
      const { rows: [actual] } = await admin.query("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [database.name]);
      if (!NAME.test(database.name) || !actual || actual.oid !== database.oid || actual.owner !== database.owner) throw new Error("Synthetic database identity changed; cleanup refused.");
      await admin.query(`DROP DATABASE "${database.name}" WITH (FORCE)`);
    }
  } finally { await admin?.end(); for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});

describe("explicit 0051 reconciliation (synthetic)", () => {
  it("dry run on exact objects with history: eligible, every invariant zero, nothing written", async () => {
    const { name, pool, before } = await scenario("dryrun", exactWithHistory);
    const report = await reconcileOrthoStrategyLegacy(pool, options(name));
    expect(report).toMatchObject({ classification: "exact", eligible: true, applied: false, refusal: null, rows: 3, differences: { missing: [], unexpected: [] } });
    expect(report.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(report.fingerprint).toBe(report.referenceFingerprint);
    expect(report.invariants.every(check => check.violations === 0)).toBe(true);
    expect(report.sequence).toMatchObject({ ok: true, maxId: "3" });
    expect(await withClient(name, state)).toEqual(before);
    // The normal startup guard is still fail closed after a dry run.
    await expect(applyOrthoAssessmentRuntime(pool)).rejects.toThrow("ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051");
  });

  it("apply with the confirmed fingerprint registers 0051 (not adopted) atomically, preserving history and sequence", async () => {
    const { name, pool, before } = await scenario("apply", exactWithHistory);
    const dry = await reconcileOrthoStrategyLegacy(pool, options(name));
    const applied = await reconcileOrthoStrategyLegacy(pool, options(name, { apply: true, expectedFingerprint: dry.fingerprint!, actor: "synthetic-operator", reason: "Synthetic reconciliation review" }));
    expect(applied).toMatchObject({ classification: "exact", eligible: true, applied: true, refusal: null });
    const after = await withClient(name, state);
    expect(after.history).toEqual(before.history);
    expect(after.sequence).toEqual(before.sequence);
    expect(after.registry).toEqual([...before.registry, { version: "0051", name: STRATEGY.name, checksum: STRATEGY.checksum, adopted: false }]
      .sort((a, b) => a.version.localeCompare(b.version)));
    expect(after.audit).toHaveLength(1);
    expect(after.audit[0]).toMatchObject({ entity: "schema_migrations", entity_id: "0051", actor: "synthetic-operator",
      details: { version: "0051", checksum: STRATEGY.checksum, fingerprint: dry.fingerprint, rows: 3, reason: "Synthetic reconciliation review" } });
    expect(after.audit[0].details.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    // Startup now proceeds: 0051 is validated as registered, 0052 is applied normally; history still intact.
    expect(await applyOrthoAssessmentRuntime(pool)).toEqual(["0052"]);
    const final = await withClient(name, state);
    expect(final.history).toEqual(before.history);
    expect(final.registry.filter(row => ["0051", "0052"].includes(row.version))).toEqual(runtime.map(file => ({ version: file.version, name: file.name, checksum: file.checksum, adopted: false })));
    // A repeat is refused as already registered and writes nothing.
    expect((await reconcileOrthoStrategyLegacy(pool, options(name, { apply: true, expectedFingerprint: dry.fingerprint!, actor: "x", reason: "repeat" }))).refusal).toBe("already_registered");
    expect(await withClient(name, state)).toEqual(final);
  });

  it.each([
    ["no fingerprint confirmation", () => ({ apply: true, actor: "op", reason: "Synthetic" }), "fingerprint_not_confirmed"],
    ["a stale fingerprint", () => ({ apply: true, expectedFingerprint: "0".repeat(64), actor: "op", reason: "Synthetic" }), "fingerprint_not_confirmed"],
    ["missing actor", (fp: string) => ({ apply: true, expectedFingerprint: fp, reason: "Synthetic" }), "actor_or_reason_invalid"],
    ["a too-short reason", (fp: string) => ({ apply: true, expectedFingerprint: fp, actor: "op", reason: "x" }), "actor_or_reason_invalid"],
  ] as const)("apply refuses %s and writes nothing", async (_label, extra, refusal) => {
    const { name, pool, before } = await scenario(`refuse${refusal.length}${_label.length}`, exactWithHistory);
    const fp = (await reconcileOrthoStrategyLegacy(pool, options(name))).fingerprint!;
    expect((await reconcileOrthoStrategyLegacy(pool, options(name, extra(fp) as Partial<ReconcileOptions>))).refusal).toBe(refusal);
    expect(await withClient(name, state)).toEqual(before);
  });

  it("refuses a different target database", async () => {
    const { name, pool, before } = await scenario("wrongdb", exactWithHistory);
    expect((await reconcileOrthoStrategyLegacy(pool, options("aqlan_some_other_database"))).refusal).toBe("database_mismatch");
    expect(await withClient(name, state)).toEqual(before);
  });

  it.each([
    ["absent", async () => {}, "absent"],
    ["partial (table only)", async (client: Client) => { await client.query(STRATEGY.sql.slice(STRATEGY.sql.indexOf("CREATE TABLE"), STRATEGY.sql.indexOf("CREATE INDEX"))); }, "partial"],
    ["conflicting legacy table", async (client: Client) => { await client.query("CREATE TABLE ortho_strategy_revisions(id INTEGER PRIMARY KEY, legacy_marker TEXT)"); await client.query("INSERT INTO ortho_strategy_revisions VALUES(7,'synthetic')"); }, "conflicting"],
    ["extra column", async (client: Client) => { await exactWithHistory(client); await client.query("ALTER TABLE ortho_strategy_revisions ADD COLUMN synthetic_extra TEXT"); }, "conflicting"],
    ["disabled trigger", async (client: Client) => { await exactWithHistory(client); await client.query("ALTER TABLE ortho_strategy_revisions DISABLE TRIGGER ortho_strategy_revision_immutable"); }, "conflicting"],
    ["changed function body", async (client: Client) => { await exactWithHistory(client); await client.query("CREATE OR REPLACE FUNCTION reject_ortho_strategy_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$"); }, "conflicting"],
    ["deferrability changed", async (client: Client) => { await exactWithHistory(client); await client.query("ALTER TABLE ortho_strategy_revisions ALTER CONSTRAINT ortho_strategy_same_case_predecessor NOT DEFERRABLE"); }, "conflicting"],
    ["missing index", async (client: Client) => { await exactWithHistory(client); await client.query("DROP INDEX ortho_strategy_patient_case_version_idx"); }, "partial"],
  ] as const)("refuses %s, even with apply, and writes nothing", async (label, setup, classification) => {
    const { name, pool, before } = await scenario(label.replace(/[^a-z]/g, "").slice(0, 20), setup);
    const report = await reconcileOrthoStrategyLegacy(pool, options(name, { apply: true, expectedFingerprint: "f".repeat(64), actor: "op", reason: "Synthetic" }));
    expect(report).toMatchObject({ classification, eligible: false, applied: false, refusal: `classification_${classification}` });
    if (classification !== "absent") expect(report.differences.missing.length + report.differences.unexpected.length).toBeGreaterThan(0);
    expect(await withClient(name, state)).toEqual(before);
  });

  it("refuses exact objects whose existing rows break the owner bridge (written while triggers were bypassed)", async () => {
    const { name, pool, before } = await scenario("invariant", async client => {
      const ids = await exactWithHistory(client);
      // A second patient's own case pair, with a revision that names the FIRST patient as owner.
      const other = (await client.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-ORTHO-OTHER','Synthetic other patient') RETURNING id")).rows[0].id;
      const ortho2 = (await client.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'synthetic') RETURNING id", [other])).rows[0].id;
      const clinical2 = (await client.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by,ortho_case_id) VALUES($1,'ortho','Synthetic case 2','synthetic',$2) RETURNING id", [other, ortho2])).rows[0].id;
      await client.query("SET session_replication_role = replica");
      await client.query(`INSERT INTO ortho_strategy_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,actor_user_id,created_by,reason,
        recording_context,command_id,request_fingerprint,rows) VALUES($1,$1,$2,$3,1,$4,'synthetic','Synthetic inconsistent','current','synthetic-command-x-0000',$5,'[{}]')`,
        [ids.patient, ortho2, clinical2, ids.user, "b".repeat(64)]);
      await client.query("SET session_replication_role = origin");
    });
    const report = await reconcileOrthoStrategyLegacy(pool, options(name, { apply: true, expectedFingerprint: "f".repeat(64), actor: "op", reason: "Synthetic" }));
    expect(report).toMatchObject({ classification: "exact", eligible: false, applied: false, refusal: "row_invariants_violated" });
    expect(report.invariants.find(check => check.check === "owner_bridge")?.violations).toBe(1);
    expect(await withClient(name, state)).toEqual(before);
  });

  it("refuses when the owned sequence is behind the existing rows", async () => {
    const { name, pool, before } = await scenario("sequence", async client => { await exactWithHistory(client); await client.query("SELECT setval('ortho_strategy_revisions_id_seq', 1)"); });
    const report = await reconcileOrthoStrategyLegacy(pool, options(name));
    expect(report).toMatchObject({ classification: "exact", eligible: false, refusal: "sequence_behind_rows", sequence: { ok: false, maxId: "3" } });
    expect(await withClient(name, state)).toEqual(before);
  });

  it("rolls back both writes when the transaction fails before commit", async () => {
    const { name, pool, before } = await scenario("rollback", exactWithHistory);
    const fp = (await reconcileOrthoStrategyLegacy(pool, options(name))).fingerprint!;
    await expect(reconcileOrthoStrategyLegacy(pool, options(name, { apply: true, expectedFingerprint: fp, actor: "op", reason: "Synthetic",
      onBeforeCommit: async () => { throw new Error("synthetic failure before commit"); } }))).rejects.toThrow("synthetic failure before commit");
    expect(await withClient(name, state)).toEqual(before);
    const locks = await withClient(name, async client => (await client.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory'")).rows[0].n);
    expect(locks).toBe(0);
  });

  it("waits for the migration advisory lock held by another session", async () => {
    const { name, pool } = await scenario("lockwait", exactWithHistory);
    const holder = new Client({ connectionString: urlFor(name), ssl: false }); await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      let finished = false;
      const pending = reconcileOrthoStrategyLegacy(pool, options(name)).then(report => { finished = true; return report; });
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(finished).toBe(false);
      await holder.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      expect((await pending).classification).toBe("exact");
    } finally { await holder.end(); }
  });

  it("two concurrent applies register 0051 exactly once", async () => {
    const { name, pool } = await scenario("concurrent", exactWithHistory);
    const fp = (await reconcileOrthoStrategyLegacy(pool, options(name))).fingerprint!;
    const other = poolFor(name);
    const apply = { apply: true, expectedFingerprint: fp, actor: "op", reason: "Synthetic concurrent" };
    const results = await Promise.all([reconcileOrthoStrategyLegacy(pool, options(name, apply)), reconcileOrthoStrategyLegacy(other, options(name, apply))]);
    expect(results.map(result => result.applied ? "applied" : result.refusal).sort()).toEqual(["already_registered", "applied"]);
    const after = await withClient(name, state);
    expect(after.registry.filter(row => row.version === "0051")).toEqual([{ version: "0051", name: STRATEGY.name, checksum: STRATEGY.checksum, adopted: false }]);
    expect(after.audit).toHaveLength(1);
  });

  it("an apply racing normal startup is serialised: startup never adopts, and the end state is consistent", async () => {
    const { name, pool, before } = await scenario("race", exactWithHistory);
    const fp = (await reconcileOrthoStrategyLegacy(pool, options(name))).fingerprint!;
    const [reconcile, startup] = await Promise.allSettled([
      reconcileOrthoStrategyLegacy(pool, options(name, { apply: true, expectedFingerprint: fp, actor: "op", reason: "Synthetic race" })),
      applyOrthoAssessmentRuntime(poolFor(name)),
    ]);
    expect(reconcile).toMatchObject({ status: "fulfilled", value: { applied: true } });
    if (startup.status === "fulfilled") expect(startup.value).toEqual(["0052"]);
    else expect(String(startup.reason)).toMatch(/ORTHO_UNREGISTERED_OBJECT_COLLISION: 0051/);
    const after = await withClient(name, state);
    expect(after.history).toEqual(before.history);
    expect(after.registry.filter(row => row.version === "0051")).toEqual([{ version: "0051", name: STRATEGY.name, checksum: STRATEGY.checksum, adopted: false }]);
    expect(after.registry.every(row => row.adopted === false)).toBe(true);
  });
});

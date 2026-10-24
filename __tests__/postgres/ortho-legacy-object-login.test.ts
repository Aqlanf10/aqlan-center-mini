import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { applySyntheticOrthoReconciliation, reportOrthoReconciliation } from "../../lib/ortho-reconciliation";
import reference from "../../schema/ortho-reconciliation-reference.pg18.json";
import { readOrthoCatalog } from "../../lib/ortho-reconciliation-catalog";
import runtime from "../../lib/ortho-assessment-runtime.generated.json";

/* Reproduces the Staging login blocker on synthetic databases only: an unregistered ortho revision object
 * with 0051/0052 missing from schema_migrations makes the fail-closed runtime guard throw inside
 * ensureSchema(), before password verification, and the login route's outer catch returns a generic 500
 * with no diagnostic. These cases pin that behaviour (guard stays fail closed, nothing is adopted, dropped
 * or rewritten) so a later explicit reconciliation can be reviewed against them. */
const auth = vi.hoisted(() => ({ verifyCalls: 0, stopBeforeOrtho: false }));
vi.mock("../../lib/auth", async importOriginal => {
  const original = await importOriginal<typeof import("../../lib/auth")>();
  return { ...original, verifyPassword: async (...args: Parameters<typeof original.verifyPassword>) => { auth.verifyCalls++; return original.verifyPassword(...args); } };
});
vi.mock("../../lib/ortho-assessment-runtime", async importOriginal => {
  const original = await importOriginal<typeof import("../../lib/ortho-assessment-runtime")>();
  return { ...original, applyOrthoAssessmentRuntime: async (...args: Parameters<typeof original.applyOrthoAssessmentRuntime>) => {
    if (auth.stopBeforeOrtho) throw new Error("SYNTHETIC_PRE_ORTHO_BOUNDARY");
    return original.applyOrthoAssessmentRuntime(...args);
  } };
});
import { ensureSchema, getPool, resetPoolForTesting } from "../../lib/db";
import { hashPassword } from "../../lib/auth";
import { applyOrthoAssessmentRuntime } from "../../lib/ortho-assessment-runtime";
import { POST } from "../../app/api/auth/login/route";

const NAME = /^aqlan_ortho_legacy_[a-f0-9]{32}(_[a-z0-9]+)?$/;
const keys = ["DATABASE_URL", "SKIP_SEED", "DB_POOL_MAX", "SESSION_SECRET"] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const owned: { name: string; oid: string; owner: string }[] = [];
let admin: Client;
let target: ReturnType<typeof validatePostgresTestTarget>;
let base = "";
const USERNAME = "synthetic_ortho_login";
const PASSWORD = "Synthetic-ortho-login-0123";
const [STRATEGY, ASSESSMENT] = runtime;
const ORTHO_FUNCTIONS = ["reject_ortho_strategy_revision_mutation", "check_ortho_strategy_revision_final_state",
  "reject_ortho_assessment_revision_mutation", "check_ortho_assessment_revision_final_state"];

const urlFor = (name: string) => { const url = new URL(target.testUrl); url.pathname = `/${name}`; return url.toString(); };
async function createOwned(name: string, template: string) {
  if (!NAME.test(name) || name.length > 63) throw new Error("Unexpected synthetic database name.");
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  const { rows: [identity] } = await admin.query("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [name]);
  if (!identity || identity.name !== name) throw new Error("Owned synthetic database identity unavailable.");
  owned.push(identity);
}
async function selectDatabase(name: string) { process.env.DATABASE_URL = urlFor(name); await resetPoolForTesting(); }
async function withClient<T>(name: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urlFor(name), ssl: false }); await client.connect();
  try { return await run(client); } finally { await client.end(); }
}
/** Registry rows plus a catalog fingerprint of every ortho revision object name the guard inspects. */
async function snapshot(client: Client) {
  const registry = (await client.query("SELECT version,name,checksum,adopted FROM schema_migrations ORDER BY version")).rows;
  const catalog = (await client.query(`
    SELECT 'relation:' || c.relname || ':' || c.relkind::text AS item FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE '%ortho\\_%revision%'
    UNION ALL SELECT 'constraint:' || con.conname || ':' || pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'ortho\\_%\\_revisions'
    UNION ALL SELECT 'trigger:' || tg.tgname || ':' || pg_get_triggerdef(tg.oid) FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid
      WHERE NOT tg.tgisinternal AND c.relname LIKE 'ortho\\_%\\_revisions'
    UNION ALL SELECT 'function:' || p.proname || ':' || md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname = ANY($1)
    UNION ALL SELECT 'type:' || t.typname FROM pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typname LIKE '%ortho\\_%\\_revisions'
    ORDER BY 1`, [ORTHO_FUNCTIONS])).rows.map(row => row.item);
  return { registry, catalog };
}
const login = () => POST(new Request("http://localhost/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
}));

beforeAll(async () => {
  target = validatePostgresTestTarget(process.env);
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false }); await admin.connect();
  process.env.SKIP_SEED = "true"; process.env.DB_POOL_MAX = "2"; process.env.SESSION_SECRET = "synthetic-ortho-legacy-login-secret-0123456789";
  base = `aqlan_ortho_legacy_${randomUUID().replaceAll("-", "")}`;
  await createOwned(base, "template0");
  await selectDatabase(base);
  await ensureSchema();
  await getPool().query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic ortho login',$2,'admin')", [USERNAME, await hashPassword(PASSWORD)]);
  await resetPoolForTesting();
  // Predecessor state: everything the candidate runtime creates except 0051/0052 (objects and registry rows).
  await withClient(base, async client => {
    await client.query("DELETE FROM schema_migrations WHERE version IN ('0051','0052')");
    await client.query("DROP TABLE ortho_assessment_revisions"); await client.query("DROP TABLE ortho_strategy_revisions");
    for (const fn of ORTHO_FUNCTIONS) await client.query(`DROP FUNCTION ${fn}()`);
  });
}, 120_000);
afterAll(async () => {
  try {
    await resetPoolForTesting();
    for (const database of [...owned].reverse()) {
      const { rows: [actual] } = await admin.query("SELECT datname AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1", [database.name]);
      if (!NAME.test(database.name) || !actual || actual.oid !== database.oid || actual.owner !== database.owner) throw new Error("Synthetic database identity changed; cleanup refused.");
      await admin.query(`DROP DATABASE "${database.name}" WITH (FORCE)`);
    }
  } finally { await admin?.end(); for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
beforeEach(() => { auth.verifyCalls = 0; });

async function scenario(suffix: string, setup: (client: Client) => Promise<void>) {
  const name = `${base}_${suffix}`;
  await resetPoolForTesting();
  await createOwned(name, base);
  await withClient(name, setup);
  const before = await withClient(name, snapshot);
  await selectDatabase(name);
  return { name, before };
}
/** The fail-closed outcome every legacy-object state must keep until an explicit, reviewed reconciliation. */
async function expectRefusedUnchanged(name: string, before: Awaited<ReturnType<typeof snapshot>>, collidingVersion: string) {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await login();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر تسجيل الدخول. أعد المحاولة." });
    expect(auth.verifyCalls).toBe(0);
    expect(errors).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "staff_login_failed", stage: "shared_limit",
      category: "ORTHO_UNREGISTERED_OBJECT_COLLISION", version: collidingVersion }));
  } finally { errors.mockRestore(); }
  await expect(ensureSchema()).rejects.toThrow(new RegExp(`^ORTHO_UNREGISTERED_OBJECT_COLLISION: ${collidingVersion}: `));
  expect(await withClient(name, snapshot)).toEqual(before);
  expect(before.registry.some(row => ["0051", "0052"].includes(row.version))).toBe(false);
}

describe("login with an unregistered legacy ortho revision object (synthetic)", () => {
  it("control: without legacy objects the candidate registers 0051/0052 and login succeeds", async () => {
    const { name } = await scenario("control", async () => {});
    const response = await login();
    expect(response.status).toBe(200);
    expect(auth.verifyCalls).toBe(1);
    const { registry } = await withClient(name, snapshot);
    expect(registry.filter(row => ["0051", "0052"].includes(row.version))).toEqual(runtime.map(file => ({ version: file.version, name: file.name, checksum: file.checksum, adopted: false })));
  });

  it("pre-Ortho: correct runtime registrations with 0067 absent still refuse legacy objects", async () => {
    const name = `${base}_preortho`;
    await resetPoolForTesting();
    await createOwned(name, "template0");
    await selectDatabase(name);
    auth.stopBeforeOrtho = true;
    try { await expect(ensureSchema()).rejects.toThrow("SYNTHETIC_PRE_ORTHO_BOUNDARY"); }
    finally { auth.stopBeforeOrtho = false; await resetPoolForTesting(); }
    await withClient(name, async client => {
      await client.query("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic predecessor',$2,'admin')", [USERNAME, await hashPassword(PASSWORD)]);
      await client.query(STRATEGY.sql);
    });
    const before = await withClient(name, snapshot);
    await selectDatabase(name);
    expect(before.registry.map(row => row.version)).toEqual(["0056", "0057", "0058", "0063", "0064", "0065", "0066", "0068", "0069"]);
    await expectRefusedUnchanged(name, before, "0051");
    expect(await withClient(name, async client => (await client.query("SELECT to_regclass('public.appointments_patient_history_idx') AS index")).rows)).toEqual([{ index: null }]);
    const expected = await capability(name);
    await withClient(name, client => applySyntheticOrthoReconciliation(client, expected));
    expect((await login()).status).toBe(200);
    expect((await withClient(name, snapshot)).registry.some(row => row.version === "0067")).toBe(true);
  });

  it("exact: the byte-identical 0051 objects without a registry row are refused, not adopted", async () => {
    const { name, before } = await scenario("exact", async client => { await client.query(STRATEGY.sql); });
    expect(before.catalog.some(item => item.startsWith("relation:ortho_strategy_revisions:r"))).toBe(true);
    await expectRefusedUnchanged(name, before, "0051");
  });

  it("partial: only the 0051 table (no index or routines) is refused, not completed", async () => {
    const tableOnly = STRATEGY.sql.slice(STRATEGY.sql.indexOf("CREATE TABLE"), STRATEGY.sql.indexOf("CREATE INDEX"));
    const { name, before } = await scenario("partial", async client => { await client.query(tableOnly); });
    expect(before.catalog.some(item => item.startsWith("function:"))).toBe(false);
    await expectRefusedUnchanged(name, before, "0051");
  });

  it("conflicting: a different legacy table with data is refused and preserved", async () => {
    const { name, before } = await scenario("conflict", async client => {
      await client.query("CREATE TABLE ortho_strategy_revisions(id INTEGER PRIMARY KEY, legacy_marker TEXT)");
      await client.query("INSERT INTO ortho_strategy_revisions VALUES(7,'synthetic legacy row')");
    });
    await expectRefusedUnchanged(name, before, "0051");
    expect(await withClient(name, async client => (await client.query("SELECT * FROM ortho_strategy_revisions")).rows)).toEqual([{ id: 7, legacy_marker: "synthetic legacy row" }]);
  });

  it("pair preflight: an exact 0052 object alone blocks before 0051 is applied", async () => {
    const { name, before } = await scenario("assessment", async client => {
      await client.query(STRATEGY.sql); await client.query(ASSESSMENT.sql);
      await client.query("DROP TABLE ortho_strategy_revisions CASCADE");
      for (const fn of ORTHO_FUNCTIONS.slice(0, 2)) await client.query(`DROP FUNCTION ${fn}()`);
    });
    await expectRefusedUnchanged(name, before, "0052");
    expect(before.catalog.some(item => item.startsWith("relation:ortho_strategy_revisions:"))).toBe(false);
  });
});


async function capability(name: string) {
  const token = randomBytes(32).toString("hex");
  await withClient(name, async client => {
    await client.query("CREATE TABLE ortho_synthetic_reconciliation_target(capability text NOT NULL)");
    await client.query("INSERT INTO ortho_synthetic_reconciliation_target VALUES($1)", [token]);
  });
  return { database: name, oid: owned.find(db => db.name === name)!.oid, capability: token };
}

describe("explicit synthetic reconciliation", () => {
  it("reports exact reference catalogs read-only and atomically records equivalence before real login/init succeeds", async () => {
    const { name } = await scenario("reconcile", async client => { await client.query(STRATEGY.sql); });
    const expected = await capability(name);
    const beforeReport = await withClient(name, snapshot);
    const cli = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/db-ortho-reconcile.ts"], {
      env: { ...process.env, ORTHO_RECONCILE_URL: urlFor(name) }, encoding: "utf8",
    }));
    expect(cli.results.map((row: { shape: string }) => row.shape)).toEqual(["exact", "absent"]);
    expect(await withClient(name, snapshot)).toEqual(beforeReport);
    await withClient(name, async client => {
      await client.query("BEGIN READ ONLY");
      const report = await reportOrthoReconciliation(client);
      expect(await readOrthoCatalog(client, "0051")).toEqual(reference.catalogs["0051"]);
      expect(report.results.map(row => row.shape)).toEqual(["exact", "absent"]);
      await client.query("ROLLBACK");
      expect(await applySyntheticOrthoReconciliation(client, expected)).toEqual({ event: "ortho_synthetic_reconciliation_recorded", versions: ["0051"], historicalExecutionVerified: false });
      expect((await client.query("SELECT evidence_kind,historical_execution_verified FROM ortho_reconciliation_records")).rows).toEqual([{ evidence_kind: "catalog_equivalence", historical_execution_verified: false }]);
    });
    const response = await login(); expect(response.status).toBe(200); expect(auth.verifyCalls).toBe(1);
  });
  it("fails closed for partial catalog and rolls back every registration", async () => {
    const { name, before } = await scenario("partapply", async client => {
      await client.query(STRATEGY.sql); await client.query("DROP INDEX ortho_strategy_patient_case_version_idx");
    });
    const expected = await capability(name);
    await expect(withClient(name, client => applySyntheticOrthoReconciliation(client, expected))).rejects.toThrow("ORTHO_RECONCILIATION_CATALOG");
    expect(await withClient(name, snapshot)).toEqual(before);
  });
});

async function syntheticRows(client: Client) {
  const patient = (await client.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-RECONCILE','Synthetic only') RETURNING id")).rows[0].id;
  const ortho = (await client.query("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,'synthetic','completed') RETURNING id", [patient])).rows[0].id;
  const clinical = (await client.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic',$2,'synthetic') RETURNING id", [patient, ortho])).rows[0].id;
  const actor = (await client.query("SELECT id FROM users WHERE username=$1", [USERNAME])).rows[0].id;
  const params = [patient, ortho, clinical, actor];
  await client.query(`INSERT INTO ortho_strategy_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,rows)
    VALUES($1,$1,$2,$3,1,$4,'synthetic','synthetic','current','synthetic_command_1234',repeat('a',64),'[{}]')`, params);
  await client.query(`INSERT INTO ortho_assessment_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,content_sha256,content)
    VALUES($1,$1,$2,$3,2,1,$4,'synthetic','synthetic','current','synthetic_command_1234',repeat('a',64),repeat('b',64),
    '{"schemaVersion":2,"verifierVersion":"ortho-assessment-payload-2.1.0","draft":{"schemaVersion":2,"analyses":[]},"results":[]}')`, params);
}
async function rowState(client: Client) {
  return {
    strategy: (await client.query("SELECT * FROM ortho_strategy_revisions ORDER BY id")).rows,
    assessment: (await client.query("SELECT * FROM ortho_assessment_revisions ORDER BY id")).rows,
    sequences: (await client.query("SELECT 'strategy' AS name,last_value,is_called FROM ortho_strategy_revisions_id_seq UNION ALL SELECT 'assessment',last_value,is_called FROM ortho_assessment_revisions_id_seq")).rows,
  };
}

describe("synthetic reconciliation preservation and refusal boundaries", () => {
  it("preserves nonempty clinical rows and sequence values for both contracts, then real login works", async () => {
    const { name } = await scenario("nonempty", async client => { await client.query(STRATEGY.sql); await client.query(ASSESSMENT.sql); await syntheticRows(client); });
    const expected = await capability(name);
    await withClient(name, async client => {
      const before = await rowState(client);
      expect((await applySyntheticOrthoReconciliation(client, expected)).versions).toEqual(["0051", "0052"]);
      expect(await rowState(client)).toEqual(before);
    });
    expect((await login()).status).toBe(200);
  });
  it.each([
    ["column", "ALTER TABLE ortho_strategy_revisions ALTER COLUMN schema_version SET DEFAULT 2"],
    ["trigger", "ALTER TABLE ortho_strategy_revisions DISABLE TRIGGER ortho_strategy_revision_final_state"],
    ["function", "CREATE OR REPLACE FUNCTION reject_ortho_strategy_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic  drift'; END $$"],
    ["sequence", "ALTER SEQUENCE ortho_strategy_revisions_id_seq OWNED BY NONE"],
    ["acl", "GRANT SELECT ON ortho_strategy_revisions TO PUBLIC"],
    ["owner", "ALTER FUNCTION reject_ortho_strategy_revision_mutation() OWNER TO pg_database_owner"],
    ["collation", 'ALTER TABLE ortho_strategy_revisions ALTER COLUMN reason TYPE text COLLATE "C"'],
    ["dependency", "CREATE VIEW synthetic_ortho_dependency AS SELECT id FROM ortho_strategy_revisions"],
  ])("refuses %s drift without changing catalog, registry or data", async (label, sql) => {
    const { name, before } = await scenario(label, async client => { await client.query(STRATEGY.sql); await client.query(sql); });
    const expected = await capability(name);
    await expect(withClient(name, client => applySyntheticOrthoReconciliation(client, expected))).rejects.toThrow("ORTHO_RECONCILIATION_CATALOG");
    expect(await withClient(name, snapshot)).toEqual(before);
  });
  it.each(["sequence", "payload", "owner"])("refuses invalid %s data despite restored exact definitions", async defect => {
    const { name } = await scenario(`bad${defect}`, async client => {
      await client.query(STRATEGY.sql); await client.query(ASSESSMENT.sql); await syntheticRows(client);
      if (defect === "sequence") await client.query("SELECT setval('ortho_strategy_revisions_id_seq',1,false)");
      else {
        await client.query("ALTER TABLE ortho_assessment_revisions DISABLE TRIGGER ALL");
        await client.query(defect === "payload" ? "UPDATE ortho_assessment_revisions SET content='{}'" : "UPDATE ortho_assessment_revisions SET clinical_case_id=clinical_case_id+1000");
        await client.query("ALTER TABLE ortho_assessment_revisions ENABLE TRIGGER ALL");
      }
    });
    const expected = await capability(name);
    const before = await withClient(name, rowState);
    await expect(withClient(name, client => applySyntheticOrthoReconciliation(client, expected))).rejects.toThrow("ORTHO_RECONCILIATION_INVARIANTS");
    expect(await withClient(name, rowState)).toEqual(before);
    expect((await withClient(name, snapshot)).registry.some(row => ["0051", "0052"].includes(row.version))).toBe(false);
  });
  it("serializes concurrent explicit requests; exactly one records the pair", async () => {
    const { name } = await scenario("concurrent", async client => { await client.query(STRATEGY.sql); await client.query(ASSESSMENT.sql); });
    const expected = await capability(name);
    const results = await Promise.allSettled([withClient(name, client => applySyntheticOrthoReconciliation(client, expected)), withClient(name, client => applySyntheticOrthoReconciliation(client, expected))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { message: "ORTHO_RECONCILIATION_REGISTRY" } });
    expect((await withClient(name, snapshot)).registry.filter(row => ["0051", "0052"].includes(row.version))).toHaveLength(2);
  });
  it.each([false, true])("rollback/uncertain COMMIT acknowledgement is truthful (commit=%s)", async commit => {
    const { name, before } = await scenario(commit ? "acklost" : "rollback", async client => { await client.query(STRATEGY.sql); });
    const expected = await capability(name);
    await withClient(name, async client => {
      const wrapped = { query: async (sql: string, values?: unknown[]) => {
        if (!commit && sql.startsWith("INSERT INTO public.schema_migrations")) throw new Error("synthetic write failure");
        const result = await client.query(sql, values);
        if (commit && sql === "COMMIT") throw new Error("synthetic acknowledgement lost");
        return result;
      } } as unknown as Client;
      await expect(applySyntheticOrthoReconciliation(wrapped, expected)).rejects.toThrow(commit ? "ORTHO_RECONCILIATION_UNCERTAIN_COMMIT" : "synthetic write failure");
      const registry = await snapshot(client);
      if (commit) {
        expect(registry.registry.some(row => row.version === "0051")).toBe(true);
        expect((await client.query("SELECT count(*)::int n FROM ortho_reconciliation_records")).rows[0].n).toBe(1);
      } else {
        expect(registry).toEqual(before);
        expect((await client.query("SELECT to_regclass('public.ortho_reconciliation_records') AS ledger")).rows[0].ledger).toBeNull();
      }
    });
  });
});


describe("transaction-time safety", () => {
  it("shares the normal runtime advisory lock without weakening startup guards", async () => {
    const { name } = await scenario("runtime", async client => { await client.query(STRATEGY.sql); });
    const expected = await capability(name);
    const competitor = new Pool({ connectionString: urlFor(name), ssl: false });
    let runtime: Promise<string[]> | undefined;
    try {
      await withClient(name, async client => {
        const wrapped = { query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql === "SELECT pg_advisory_xact_lock($1)") runtime = applyOrthoAssessmentRuntime(competitor);
          return result;
        } } as unknown as Client;
        await applySyntheticOrthoReconciliation(wrapped, expected);
      });
      expect(await runtime).toEqual(["0052"]);
    } finally { await competitor.end(); }
    expect((await login()).status).toBe(200);
  });
  it("rechecks drift introduced after an earlier exact report", async () => {
    const { name } = await scenario("latechange", async client => { await client.query(STRATEGY.sql); });
    const expected = await capability(name);
    await withClient(name, async client => {
      expect((await reportOrthoReconciliation(client)).results[0].shape).toBe("exact");
      let changed = false;
      const wrapped = { query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (!changed && sql === "SELECT capability FROM public.ortho_synthetic_reconciliation_target") {
          changed = true;
          await withClient(name, other => other.query("ALTER SEQUENCE ortho_strategy_revisions_id_seq INCREMENT BY 2"));
        }
        return result;
      } } as unknown as Client;
      await expect(applySyntheticOrthoReconciliation(wrapped, expected)).rejects.toThrow("ORTHO_RECONCILIATION_CATALOG");
      expect((await snapshot(client)).registry.some(row => row.version === "0051")).toBe(false);
    });
  });
  it("blocks function replacement while the reconciliation catalogs are locked", async () => {
    const { name } = await scenario("lockeddrift", async client => { await client.query(STRATEGY.sql); });
    const expected = await capability(name);
    await withClient(name, async client => {
      let attempted = false;
      const wrapped = { query: async (sql: string, values?: unknown[]) => {
        const result = await client.query(sql, values);
        if (sql.startsWith("ALTER SEQUENCE public.")) {
          await withClient(name, async other => {
            await other.query("SET lock_timeout='250ms'");
            await expect(other.query("SELECT setval('ortho_strategy_revisions_id_seq',50,true)")).rejects.toMatchObject({ code: "55P03" });
          });
        }
        if (sql.startsWith("LOCK TABLE pg_catalog.pg_class")) {
          attempted = true;
          await withClient(name, async other => {
            await other.query("SET lock_timeout='250ms'");
            await expect(other.query("ALTER FUNCTION reject_ortho_strategy_revision_mutation() IMMUTABLE")).rejects.toMatchObject({ code: "55P03" });
          });
        }
        return result;
      } } as unknown as Client;
      await applySyntheticOrthoReconciliation(wrapped, expected);
      expect(attempted).toBe(true);
    });
  });
  it("refuses a wrong exact target identity before registration", async () => {
    const { name, before } = await scenario("wrongtarget", async client => { await client.query(STRATEGY.sql); });
    const expected = await capability(name);
    await expect(withClient(name, client => applySyntheticOrthoReconciliation(client, { ...expected, oid: "1" }))).rejects.toThrow("ORTHO_RECONCILIATION_TARGET");
    expect(await withClient(name, snapshot)).toEqual(before);
  });
});

describe("standalone collisions in the complete guard scope", () => {
  it.each([
    ["0051", "sctable", "CREATE TABLE ortho_strategy_case_version_unique(id integer)"],
    ["0051", "scindex", "CREATE INDEX ortho_strategy_command_unique ON users(id)"],
    ["0052", "actype", "CREATE TYPE ortho_assessment_first_revision AS ENUM ('synthetic')"],
  ])("does not report a standalone %s collision as absent (%s)", async (version, suffix, sql) => {
    const { name, before } = await scenario(suffix, async client => { await client.query(sql); });
    await withClient(name, async client => {
      await client.query("BEGIN READ ONLY");
      expect((await reportOrthoReconciliation(client)).results.find(row => row.version === version)?.shape).toBe("unknown_or_partial");
      await client.query("ROLLBACK");
    });
    await expect(ensureSchema()).rejects.toThrow(`ORTHO_UNREGISTERED_OBJECT_COLLISION: ${version}:`);
    expect(await withClient(name, snapshot)).toEqual(before);
  });
});

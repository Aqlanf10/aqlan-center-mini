import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import runtime from "../../lib/ortho-assessment-runtime.generated.json";

/* Reproduces the Staging login blocker on synthetic databases only: an unregistered ortho revision object
 * with 0051/0052 missing from schema_migrations makes the fail-closed runtime guard throw inside
 * ensureSchema(), before password verification, and the login route's outer catch returns a generic 500
 * with no diagnostic. These cases pin that behaviour (guard stays fail closed, nothing is adopted, dropped
 * or rewritten) so a later explicit reconciliation can be reviewed against them. */
const auth = vi.hoisted(() => ({ verifyCalls: 0 }));
vi.mock("../../lib/auth", async importOriginal => {
  const original = await importOriginal<typeof import("../../lib/auth")>();
  return { ...original, verifyPassword: async (...args: Parameters<typeof original.verifyPassword>) => { auth.verifyCalls++; return original.verifyPassword(...args); } };
});
import { ensureSchema, getPool, resetPoolForTesting } from "../../lib/db";
import { hashPassword } from "../../lib/auth";
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
  if (!NAME.test(name)) throw new Error("Unexpected synthetic database name.");
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
    // Current behaviour pinned for the logging proposal: the cause reaches neither the response nor a log line.
    expect(errors).not.toHaveBeenCalled();
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

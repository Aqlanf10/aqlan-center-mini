/** Source-only until separately authorized. Real canonical listLabOrders SQL,
 * synthetic rows, PostgreSQL 18 checked before each CREATE and schema DDL.
 * Creates/drops only a fresh, random per-test database; never resets the
 * configured target schema and never touches real patient information. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertPostgres18VersionNum } from "../../scripts/verify-schema-ownership";
import type { LabOrderStatus } from "../../lib/lab";

let target: ReturnType<typeof validatePostgresTestTarget>;
let database: string;
let created = false;
let db: typeof import("../../lib/db") | undefined;
let patientSequence = 0;
let createdOid: string | undefined;
let createdServer: ServerIdentity | undefined;
type ServerIdentity = { version: string; address: string; port: number; started: string; username: string };

function assertSameTarget() {
  const current = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
  if (current.testUrl.toString() !== target.testUrl.toString()
    || current.maintenanceUrl.toString() !== target.maintenanceUrl.toString()) {
    throw new Error("Synthetic scope target changed; refusing database DDL.");
  }
}

async function serverIdentity(client: Client, expectedDatabase: string): Promise<ServerIdentity> {
  const { rows: [identity] } = await client.query<ServerIdentity & { database: string }>(`SELECT
    current_setting('server_version_num') AS version, host(inet_server_addr()) AS address,
    inet_server_port() AS port, EXTRACT(EPOCH FROM pg_postmaster_start_time())::text AS started,
    current_user AS username, current_database() AS database`);
  assertPostgres18VersionNum(identity?.version ?? "0");
  const host = target.testUrl.hostname.replace(/^\[|\]$/g, "");
  const addresses = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
  if (identity.database !== expectedDatabase || !addresses.includes(identity.address)
    || identity.port !== Number(target.testUrl.port || 5432)) {
    throw new Error("Unexpected synthetic PostgreSQL server/database identity.");
  }
  const result = { version: identity.version, address: identity.address, port: identity.port,
    started: identity.started, username: identity.username };
  if (createdServer && JSON.stringify(result) !== JSON.stringify(createdServer)) {
    throw new Error("Synthetic PostgreSQL server identity changed; refusing DDL.");
  }
  return result;
}

async function createdDatabaseIdentity(client: Client): Promise<string> {
  const { rows: [identity] } = await client.query<{ oid: string; owner: string }>(
    "SELECT oid::text AS oid, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1", [database]);
  if (!created || !identity || identity.owner !== createdServer?.username
    || (createdOid !== undefined && identity.oid !== createdOid)) {
    throw new Error("Synthetic database ownership/OID is unproven; refusing DDL.");
  }
  return identity.oid;
}

beforeEach(async () => {
  created = false; createdOid = undefined; createdServer = undefined; patientSequence = 0;
  // Original environment and target must pass before a client, stub, or DDL.
  target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
  if ([...target.testUrl.searchParams.keys()].some(key => key !== "sslmode")) {
    throw new Error("Unexpected test connection override.");
  }
  database = `aqlan_schema_ownership_ls_${randomUUID().replace(/-/g, "")}`;
  if (!/^aqlan_schema_ownership_ls_[a-f0-9]{32}$/.test(database)) throw new Error("Unsafe fixture database name.");
  assertSameTarget();
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  try {
    createdServer = await serverIdentity(admin, "postgres");
    assertSameTarget();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    createdOid = await createdDatabaseIdentity(admin);
  }
  finally { await admin.end(); }
  const url = new URL(target.testUrl); url.pathname = `/${database}`;
  // Verify the generated database on the same server before schema DDL too.
  const fixture = new Client({ connectionString: url.toString(), ssl: false });
  await fixture.connect();
  try {
    await serverIdentity(fixture, database);
    await createdDatabaseIdentity(fixture);
    assertSameTarget();
  } finally { await fixture.end(); }
  vi.stubEnv("DATABASE_URL", url.toString());
  vi.stubEnv("TEST_DATABASE_URL", url.toString());
  vi.stubEnv("DATABASE_ENVIRONMENT", "test");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("USE_LOCAL_DB", "false");
  vi.stubEnv("SKIP_SEED", "true");
  db = await import("../../lib/db");
  await db.resetPoolForTesting();
  await db.ensureSchema();
});

async function cleanupCreatedDatabase() {
  if (!created) return;
  if (!/^aqlan_schema_ownership_ls_[a-f0-9]{32}$/.test(database) || !createdOid || !createdServer) {
    throw new Error("Refusing unproven synthetic database cleanup target.");
  }
  assertSameTarget();
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  try {
    await serverIdentity(admin, "postgres");
    await createdDatabaseIdentity(admin);
    assertSameTarget();
    // No FORCE: unexpected live connections leave the fixture for diagnosis.
    await admin.query(`DROP DATABASE ${database}`);
    created = false;
  } finally { await admin.end(); }
}

afterEach(async () => {
  const failures: unknown[] = [];
  try { await db?.resetPoolForTesting(); }
  catch (error) { failures.push(error); }
  vi.unstubAllEnvs();
  try { await cleanupCreatedDatabase(); }
  catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, "Synthetic lab scope cleanup failed.");
});

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db!.getPool().query<T>(sql, values)).rows;
const insertId = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;
const patient = () => insertId(`INSERT INTO patients(patient_number, full_name)
  VALUES ($1, 'Synthetic scope patient') RETURNING id`, [`SYN-SCOPE-${++patientSequence}`]);
const order = (patientId: number, dueDate: string, status: LabOrderStatus = "sent") =>
  insertId(`INSERT INTO lab_orders(patient_id, lab_name, work_type, sent_date, due_date, status)
    VALUES ($1, 'Synthetic scope lab', 'Synthetic crown', '2000-01-01', $2, $3) RETURNING id`, [patientId, dueDate, status]);

async function writeSnapshot() {
  const result: Record<string, unknown[]> = {};
  for (const table of ["lab_orders", "lab_order_tracking", "payables", "audit_log"] as const) {
    result[table] = await q(`SELECT * FROM ${table} ORDER BY id`);
  }
  return result;
}

describe("canonical patient lab read window on PostgreSQL 18", () => {
  it("filters before LIMIT so 300 other patients cannot crowd out target rows", async () => {
    const patientId = await patient();
    const first = await order(patientId, "2025-01-01");
    const unrelated = await q<{ id: number; patient_id: number }>(`
      WITH patients_created AS (
        INSERT INTO patients(patient_number, full_name)
        SELECT 'SYN-OTHER-' || n, 'Synthetic other patient ' || n FROM generate_series(1, 300) n RETURNING id
      )
      INSERT INTO lab_orders(patient_id, lab_name, work_type, sent_date, due_date, status)
      SELECT id, 'Synthetic unrelated lab', 'Synthetic other work', '2026-01-01', '2026-01-02', 'sent'
      FROM patients_created RETURNING id, patient_id`);
    expect(new Set(unrelated.map(value => value.patient_id)).size).toBe(300);
    const later = await order(patientId, "2099-01-01");
    const tiedLater = await order(patientId, "2099-01-01");
    const before = await writeSnapshot();
    const global = await db!.listLabOrders();
    expect(global.map(value => value.id)).toEqual([
      first, ...unrelated.map(value => value.id).sort((a, b) => b - a).slice(0, 299),
    ]);
    expect(global).toHaveLength(300);
    expect(global.some(value => value.id === later || value.id === tiedLater)).toBe(false);
    const scoped = await db!.listLabOrders({ patientId });
    expect(scoped.map(value => value.id)).toEqual([first, tiedLater, later]);
    expect(scoped.every(value => value.patientId === patientId)).toBe(true);
    expect(await writeSnapshot()).toEqual(before);
  });

  it("keeps the exact 300-row patient window and deterministic due-date/id ordering", async () => {
    const patientId = await patient();
    const ids = await q<{ id: number }>(`INSERT INTO lab_orders(patient_id, lab_name, work_type, sent_date, due_date, status)
      SELECT $1, 'Synthetic bounded lab', 'Synthetic bounded work', '2000-01-01', '2000-01-02', 'sent'
      FROM generate_series(1, 301) RETURNING id`, [patientId]);
    const scoped = await db!.listLabOrders({ patientId });
    expect(scoped).toHaveLength(300);
    expect(scoped.map(value => value.id)).toEqual(ids.map(value => value.id).sort((a, b) => b - a).slice(0, 300));
    // More than 300 patient orders are still bounded, not a complete archive.
    expect(await db!.listLabOrders({ patientId: await patient() })).toEqual([]);
  });

  it("characterizes historical category enrichment and preserves the separate global JOIN behavior", async () => {
    const patientId = await patient();
    const partyId = await insertId(`INSERT INTO parties(kind, name, expense_account_code, payable_account_code)
      VALUES ('lab', 'Synthetic historical lab', '5901', '2101') RETURNING id`);
    const categoryId = await insertId(`INSERT INTO expense_categories(key, name, account_code)
      VALUES ('synthetic-scope-category', 'Synthetic historical category', '5102') RETURNING id`);
    const statuses = ["needed", "sent", "in_progress", "received", "delivered", "remake", "cancelled"] as const;
    const ids: number[] = [];
    for (const status of statuses) {
      ids.push(await insertId(`INSERT INTO lab_orders(patient_id, lab_name, work_type, sent_date, due_date, status,
          delivered_at, party_id, expense_category_id, cost_minor, cost_currency, base_amount_minor,
          exchange_rate, financial_status, is_posted, posted_at, expense_account_code, payable_account_code)
        VALUES ($1, 'Synthetic historical lab', 'Synthetic historical work', '2000-01-01', '2000-01-02', $2,
          CASE WHEN $2 = 'delivered' THEN '2000-01-03'::timestamptz ELSE NULL END,
          $3, $4, 11111, 'YER', 22222, 2, 'pending_post', FALSE, NULL, NULL, NULL) RETURNING id`,
      [patientId, status, partyId, categoryId]));
    }
    const explicitOrderId = await insertId(`INSERT INTO lab_orders(patient_id, lab_name, work_type, due_date, status,
        party_id, expense_category_id, expense_account_code, payable_account_code)
      VALUES ($1, 'Synthetic historical lab', 'Synthetic explicit account', '2000-01-02', 'cancelled', $2, $3, '5201', '2201') RETURNING id`,
    [patientId, partyId, categoryId]);
    const defaultOrderId = await order(patientId, "2000-01-02", "cancelled");
    const before = await writeSnapshot();
    const scoped = await db!.listLabOrders({ patientId });
    const global = await db!.listLabOrders();
    const expectedIds = [...ids, explicitOrderId, defaultOrderId].sort((a, b) => b - a);
    // The pre-existing global AND belongs to LEFT JOIN ON: historical rows are
    // still members, but delivered-old/remake/cancelled lose category enrichment.
    expect(scoped.map(value => value.id)).toEqual(expectedIds);
    expect(global.map(value => value.id)).toEqual(expectedIds);
    for (const [index, id] of ids.entries()) {
      const scopedOrder = scoped.find(value => value.id === id)!;
      const globalOrder = global.find(value => value.id === id)!;
      expect(scopedOrder).toEqual(await db!.getLabOrderById(id));
      expect(scopedOrder).toMatchObject({ status: statuses[index], expenseCategoryId: categoryId,
        expenseCategoryName: "Synthetic historical category", expenseCategoryKey: "synthetic-scope-category",
        expenseAccountCode: "5102", payableAccountCode: "2101", costMinor: 11111, costCurrency: "YER",
        baseAmountMinor: 22222, exchangeRate: 2, financialStatus: "pending_post", isPosted: false, postedAt: null });
      const historical = ["delivered", "remake", "cancelled"].includes(statuses[index]);
      expect(globalOrder).toMatchObject({ expenseCategoryId: categoryId,
        expenseCategoryName: historical ? null : "Synthetic historical category",
        expenseCategoryKey: historical ? null : "synthetic-scope-category",
        expenseAccountCode: historical ? "5901" : "5102" });
      const categoryFields = ["expenseCategoryName", "expenseCategoryKey", "expenseAccountCode", "expenseAccountName"];
      const withoutCategory = (value: typeof scopedOrder) => Object.fromEntries(Object.entries(value).filter(([key]) => !categoryFields.includes(key)));
      expect(withoutCategory(scopedOrder)).toEqual(withoutCategory(globalOrder));
    }
    for (const orders of [scoped, global]) {
      expect(orders.find(value => value.id === explicitOrderId)).toMatchObject({ expenseAccountCode: "5201", payableAccountCode: "2201" });
      expect(orders.find(value => value.id === defaultOrderId)).toMatchObject({ expenseAccountCode: "5101", payableAccountCode: "2101" });
    }
    expect(await writeSnapshot()).toEqual(before);
  });
});

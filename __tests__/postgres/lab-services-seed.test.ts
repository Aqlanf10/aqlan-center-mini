import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LAB_SERVICES } from "../../lib/lab";
import { seedDefaultLabServices } from "../../lib/lab-services-seed";
import { validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";

let target: ReturnType<typeof validateOwnershipHarnessEnvironment>;
let database: string;
let connectionString: string;
let created = false;
let observer: Client | undefined;
let db: typeof import("../../lib/db") | undefined;
const pools: Pool[] = [];

beforeAll(() => {
  target = validateOwnershipHarnessEnvironment();
  if ([...target.testUrl.searchParams.keys()].some((key) => key !== "sslmode")) throw new Error("Unexpected test connection override.");
});

beforeEach(async () => {
  created = false;
  observer = undefined;
  database = `aqlan_schema_ownership_lab_${randomUUID().replace(/-/g, "")}`;
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database}`); created = true; }
  finally { await admin.end(); }
  const url = new URL(target.testUrl); url.pathname = `/${database}`;
  connectionString = url.toString();
  vi.stubEnv("DATABASE_URL", connectionString);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("USE_LOCAL_DB", "false");
  vi.stubEnv("SKIP_SEED", "true");
  db = await import("../../lib/db");
  await db.resetPoolForTesting();
  await db.ensureSchema();
  observer = new Client({ connectionString, ssl: false });
  await observer.connect();
});

afterEach(async () => {
  await db?.resetPoolForTesting();
  await observer?.end();
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (!created) return;
  const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  try { await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); }
  finally { await admin.end(); }
});

async function coldStart() {
  vi.stubEnv("SKIP_SEED", "false");
  db!.schemaReadyReset();
  await db!.ensureSchema();
}

async function catalogRows() {
  return (await observer!.query("SELECT * FROM lab_services ORDER BY code")).rows;
}

async function defaultCounts() {
  return (await observer!.query(`SELECT
    (SELECT COUNT(*)::int FROM lab_services) AS labs,
    (SELECT COUNT(*)::int FROM expense_categories) AS expenses,
    (SELECT COUNT(*)::int FROM appointment_services) AS appointments
  `)).rows[0];
}

function poolFor() {
  const pool = new Pool({ connectionString, ssl: false, max: 3 });
  pools.push(pool);
  return pool;
}

describe("fresh lab-service bootstrap on PostgreSQL 18", () => {
  it("keeps SKIP_SEED free of lab, expense and appointment defaults", async () => {
    expect(await defaultCounts()).toEqual({ labs: 0, expenses: 0, appointments: 0 });
    await db!.ensureSchema();
    expect(await defaultCounts()).toEqual({ labs: 0, expenses: 0, appointments: 0 });
  });

  it("persists every canonical default field instead of implicit table defaults", async () => {
    await coldStart();
    const rows = await catalogRows();
    expect(rows).toHaveLength(DEFAULT_LAB_SERVICES.length);
    for (const item of DEFAULT_LAB_SERVICES) {
      expect(rows.find((row) => row.code === item.code)).toMatchObject({
        name: item.name, code: item.code, category: item.category,
        tooth_scope: item.toothScope, requires_shade: item.requiresShade,
        default_days: item.defaultDays, description: item.description,
        sort_order: item.sortOrder, is_active: true,
      });
    }
  });

  it.each([
    ["DNT_FULL", 1],
    ["MOD_STD", 1],
    ["CRW_ZIRC", 6],
    ["BRG_ZIRC", 6],
  ])("prices actual %s orders and payables at the canonical quantity %i", async (code, quantity) => {
    await coldStart();
    const { rows: [service] } = await observer!.query("SELECT id FROM lab_services WHERE code=$1", [code]);
    const { rows: [patient] } = await observer!.query("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-LAB-SEED','Synthetic lab seed') RETURNING id");
    const { rows: [party] } = await observer!.query("INSERT INTO parties(name,kind,currency) VALUES ('Synthetic seed lab','lab','YER') RETURNING id");
    await db!.createLabPricingRule({
      partyId: party.id, labServiceId: service.id, costMinor: 1000,
      costCurrency: "YER", effectiveFrom: "2026-01-01", createdBy: "synthetic-seed-test",
    });
    const order = await db!.createLabOrder({
      patientId: patient.id, labName: "Synthetic seed lab", labPhone: null,
      workType: "Synthetic lab order", details: null, sentDate: "2026-10-02",
      dueDate: "2026-10-10", note: null, partyId: party.id,
      costMinor: null, costCurrency: null, baseCurrency: "YER", exchangeRate: 1,
      createdBy: "synthetic-seed-test", labServiceId: service.id,
      toothNumbers: "11,12,13,14,15,16",
    });
    expect(order).not.toBeNull();
    const { rows: [stored] } = await observer!.query("SELECT cost_minor::int AS amount,cost_currency FROM lab_orders WHERE id=$1", [order!.id]);
    expect(stored).toEqual({ amount: 1000 * quantity, cost_currency: "YER" });
    const { rows: payables } = await observer!.query("SELECT amount_minor::int AS amount,currency FROM payables WHERE lab_order_id=$1", [order!.id]);
    expect(payables).toEqual([{ amount: 1000 * quantity, currency: "YER" }]);
    const before = await catalogRows();
    await coldStart();
    expect(await catalogRows()).toEqual(before);
    expect((await observer!.query("SELECT cost_minor::int AS amount FROM lab_orders WHERE id=$1", [order!.id])).rows).toEqual([{ amount: 1000 * quantity }]);
    expect((await observer!.query("SELECT amount_minor::int AS amount FROM payables WHERE lab_order_id=$1", [order!.id])).rows).toEqual([{ amount: 1000 * quantity }]);
  });

  it("rolls back a rejected default, logs locally, and still seeds independent catalogs", async () => {
    await observer!.query("ALTER TABLE lab_services ADD CONSTRAINT reject_third_default CHECK (code <> 'VNR_EMAX')");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(coldStart()).resolves.toBeUndefined();
    const afterFailure = await defaultCounts();
    expect(afterFailure.labs).toBe(0);
    expect(error).toHaveBeenCalledWith("[db] lab services seed skipped:", expect.objectContaining({ code: "23514" }));
    expect(afterFailure.expenses).toBeGreaterThan(0);
    expect(afterFailure.appointments).toBeGreaterThan(0);
    await observer!.query("ALTER TABLE lab_services DROP CONSTRAINT reject_third_default");
    await coldStart();
    expect(await defaultCounts()).toEqual({ ...afterFailure, labs: DEFAULT_LAB_SERVICES.length });
  });

  it("preserves an owner's nonempty custom catalog without adding missing defaults", async () => {
    await observer!.query(`INSERT INTO lab_services(name,code,category,tooth_scope,requires_shade,description,default_days,sort_order,is_active)
      VALUES ('Owner custom','OWNER_ONLY','other','general',FALSE,'Owner notes',12,777,FALSE)`);
    const before = await catalogRows();
    await coldStart();
    await coldStart();
    expect(await catalogRows()).toEqual(before);
  });

  it("does not overwrite an existing partial legacy catalog or fill missing codes", async () => {
    // Existing metadata may reflect an old default or a deliberate owner choice;
    // startup cannot safely distinguish them and must preserve both.
    await observer!.query(`INSERT INTO lab_services(name,code,category,tooth_scope,requires_shade,description,default_days,sort_order,is_active)
      VALUES ('Owner full denture','DNT_FULL','prostho','single_tooth',TRUE,NULL,21,333,FALSE)`);
    const before = await catalogRows();
    await coldStart();
    expect(await catalogRows()).toEqual(before);
  });

  it("preserves owner edits, deactivation and deletion across repeated cold starts", async () => {
    await coldStart();
    const rows = await catalogRows();
    await db!.deleteLabService(rows.find((row) => row.code === "CRW_ZIRC").id);
    await db!.updateLabService(rows.find((row) => row.code === "CRW_EMAX").id, {
      name: "Owner modified", isActive: false, toothScope: "general", requiresShade: false,
      description: "Owner instructions", defaultDays: 27, sortOrder: 999,
    });
    const before = await catalogRows();
    await coldStart();
    await coldStart();
    expect(await catalogRows()).toEqual(before);
    expect((await catalogRows()).some((row) => row.code === "CRW_ZIRC")).toBe(false);
  });

  it("keeps empty-catalog reseeding behavior and does not introduce a marker", async () => {
    await coldStart();
    await observer!.query("DELETE FROM lab_services");
    await coldStart();
    expect(await catalogRows()).toHaveLength(DEFAULT_LAB_SERVICES.length);
  });

  it("seeds once across independent PostgreSQL connections", async () => {
    await Promise.all([seedDefaultLabServices(poolFor()), seedDefaultLabServices(poolFor())]);
    const rows = await catalogRows();
    expect(rows).toHaveLength(DEFAULT_LAB_SERVICES.length);
    expect(new Set(rows.map((row) => row.code)).size).toBe(DEFAULT_LAB_SERVICES.length);
    await seedDefaultLabServices(poolFor());
    expect(await catalogRows()).toEqual(rows);
  });
});

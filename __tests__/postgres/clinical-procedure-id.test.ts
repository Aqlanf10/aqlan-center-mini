import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { validatePostgresTestTarget } from "./_safe-target";

// Validate original environment before connecting or replacing any URL. The
// canonical guard requires explicit TEST_DATABASE_URL, loopback and a test name.
const target = validatePostgresTestTarget();
if (process.env.USE_LOCAL_DB === "true") throw new Error("Real PostgreSQL is required.");
const isolatedName = `aqlan_procedure_id_test_${randomUUID().replaceAll("-", "")}`;
const namePattern = /^aqlan_procedure_id_test_[a-f0-9]{32}$/;
if (!namePattern.test(isolatedName)) throw new Error("Unsafe fixture database name");
const isolatedUrl = new URL(target.testUrl);
isolatedUrl.pathname = `/${isolatedName}`;
const managed = ["DATABASE_URL", "TEST_DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING", "NODE_ENV", "DATABASE_ENVIRONMENT", "USE_LOCAL_DB", "SKIP_SEED"] as const;
const environment = process.env as Record<string, string | undefined>;
const previous = Object.fromEntries(managed.map(key => [key, environment[key]]));
const admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
let connected = false;
let created = false;
let identity: { oid: string; owner: string } | undefined;
let db: typeof import("../../lib/db") | undefined;
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> => {
  if (!db) throw new Error("Owned fixture is not initialized");
  return (await db.getPool().query(sql, values)).rows as T[];
};
let sequence = 0;
let doctorId = 0;
let serviceId = 0;

beforeAll(async () => {
  await admin.connect();
  connected = true;
  // A collision fails rather than dropping any pre-existing database.
  await admin.query(`CREATE DATABASE "${isolatedName}" TEMPLATE template0`);
  created = true;
  const { rows: [owned] } = await admin.query<{ oid: string; owner: string }>(
    "SELECT oid::text, datdba::text AS owner FROM pg_database WHERE datname = $1", [isolatedName],
  );
  if (!owned) throw new Error("Owned fixture identity unavailable");
  identity = owned;
  db = await import("../../lib/db");
  await db.resetPoolForTesting();
  environment.DATABASE_URL = isolatedUrl.toString();
  environment.TEST_DATABASE_URL = isolatedUrl.toString();
  for (const key of ["POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING", "USE_LOCAL_DB"]) delete environment[key];
  environment.NODE_ENV = "test";
  environment.DATABASE_ENVIRONMENT = "test";
  environment.SKIP_SEED = "true";
  const [actual] = await q<{ name: string; oid: string; owner: string }>(
    "SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname = current_database()",
  );
  expect(actual).toEqual({ name: isolatedName, ...identity });
  await db.ensureSchema();
  doctorId = (await q<{ id: number }>(
    "INSERT INTO parties (name, kind) VALUES ('SYNTHETIC procedure ID doctor', 'doctor') RETURNING id",
  ))[0].id;
  serviceId = (await q<{ id: number }>(
    "INSERT INTO services (name, category, price_minor, price_configured, is_active) VALUES ('SYNTHETIC procedure ID work', 'cleaning', 10000, TRUE, TRUE) RETURNING id",
  ))[0].id;
}, 180_000);
afterAll(async () => {
  const failures: unknown[] = [];
  try { await db?.resetPoolForTesting(); } catch (error) { failures.push(error); }
  try {
    if (created) {
      if (!identity || !namePattern.test(isolatedName) || isolatedUrl.pathname !== `/${isolatedName}`
        || isolatedUrl.pathname === target.testUrl.pathname) throw new Error("Cleanup of unowned database refused");
      const { rows } = await admin.query<{ name: string; oid: string; owner: string }>(
        "SELECT datname AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname = $1", [isolatedName],
      );
      if (rows.length !== 1 || rows[0].name !== isolatedName || rows[0].oid !== identity.oid || rows[0].owner !== identity.owner) {
        throw new Error("Fixture identity changed; cleanup refused");
      }
      await admin.query(`DROP DATABASE "${isolatedName}"`);
    }
  } catch (error) { failures.push(error); }
  finally {
    if (connected) try { await admin.end(); } catch (error) { failures.push(error); }
    for (const key of managed) {
      if (previous[key] === undefined) delete environment[key]; else environment[key] = previous[key];
    }
  }
  if (failures.length) throw new AggregateError(failures, "Procedure ID fixture cleanup incomplete");
});

async function fixture(explicitId: string | null = null) {
  sequence += 1;
  const patientId = (await q<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, 'SYNTHETIC procedure ID patient') RETURNING id",
    [`PROCEDURE-ID-${sequence}`],
  ))[0].id;
  const planId = (await q<{ id: number }>(
    "INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, consent_at) VALUES ($1, 'SYNTHETIC procedure ID plan', 10000, 'YER', 'active', NOW()) RETURNING id",
    [patientId],
  ))[0].id;
  const itemId = (await q<{ id: number }>(
    "INSERT INTO plan_items (plan_id, service_id, service_name, category, quantity, unit_price_minor, billing_rule, session_count, status) VALUES ($1, $2, 'SYNTHETIC procedure ID work', 'cleaning', 1, 10000, 'on_completion', 1, 'planned') RETURNING id",
    [planId, serviceId],
  ))[0].id;
  const visitId = (await q<{ id: number }>(
    "INSERT INTO visits (patient_name, patient_id, status, doctor_id, diagnosis) VALUES ('SYNTHETIC procedure ID patient', $1, 'waiting', $2, 'SYNTHETIC diagnosis') RETURNING id",
    [patientId, doctorId],
  ))[0].id;
  const rows = explicitId === null
    ? await q<{ id: string }>(
      "INSERT INTO visit_procedures (visit_id, service_id, plan_item_id, doctor_id, quantity, unit_price_minor) VALUES ($1, $2, $3, $4, 1, 10000) RETURNING id",
      [visitId, serviceId, itemId, doctorId],
    )
    : await q<{ id: string }>(
      "INSERT INTO visit_procedures (id, visit_id, service_id, plan_item_id, doctor_id, quantity, unit_price_minor) VALUES ($1::bigint, $2, $3, $4, $5, 1, 10000) RETURNING id",
      [explicitId, visitId, serviceId, itemId, doctorId],
    );
  expect(typeof rows[0].id).toBe("string");
  return { patientId, visitId, itemId, rawId: rows[0].id };
}

describe("real PostgreSQL BIGSERIAL clinical read contract", () => {
  it("exposes one safe numeric ID consistently in procedures and session pricing", async () => {
    const f = await fixture();
    const visit = await db!.getClinicalVisit(f.visitId);
    expect(visit).not.toBeNull();
    expect(visit!.procedures).toHaveLength(1);
    expect(visit!.procedures[0].id).toBe(Number(f.rawId));
    expect(Number.isSafeInteger(visit!.procedures[0].id)).toBe(true);
    expect(visit!.sessionPricing).toHaveLength(1);
    expect(visit!.sessionPricing[0]).toMatchObject({
      procedureId: visit!.procedures[0].id, planItemId: f.itemId,
      financialReviewRequired: false, clinicalConsentRecorded: true,
    });
    const json = JSON.parse(JSON.stringify(visit));
    expect(typeof json.procedures[0].id).toBe("number");
    expect(json.sessionPricing[0].procedureId).toBe(json.procedures[0].id);
    expect((await q("SELECT id FROM invoices WHERE patient_id = $1", [f.patientId]))).toEqual([]);
  });

  it("fails closed on an int8 ID outside the safe range without rounding or financial writes", async () => {
    const f = await fixture("9007199254740993");
    expect(f.rawId).toBe("9007199254740993");
    await expect(db!.getClinicalVisit(f.visitId)).rejects.toThrow("Invalid clinical procedure identifier");
    expect(await q("SELECT id FROM visit_procedures WHERE visit_id = $1", [f.visitId]))
      .toEqual([{ id: "9007199254740993" }]);
    expect(await q("SELECT signed_at, invoice_id FROM visits WHERE id = $1", [f.visitId]))
      .toEqual([{ signed_at: null, invoice_id: null }]);
    expect(await q("SELECT id FROM invoices WHERE patient_id = $1", [f.patientId])).toEqual([]);
    expect(await q("SELECT id FROM payments WHERE patient_id = $1", [f.patientId])).toEqual([]);
  });
});

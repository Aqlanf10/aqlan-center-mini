import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LabOrder } from "../../lib/lab";
import { PATIENT_LAB_QUERY_MONEY, seedPatientLabQuery } from "../fixtures/patient-lab-query";
import { authedGet, baseUrl, harness, TEST_USERS, type Session } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let fixture: Awaited<ReturnType<typeof seedPatientLabQuery>>;
let beforeReads: unknown;
type Envelope = { orders: LabOrder[]; labs: { labName: string; labPhone: string | null }[]; labServices?: unknown[] };

const queryPath = (patientId: number | string) => `/api/lab?patientId=${encodeURIComponent(patientId)}`;
const money = (orders: LabOrder[]) => orders.map(({ costMinor, costCurrency, baseAmountMinor, exchangeRate }) =>
  ({ costMinor, costCurrency, baseAmountMinor, exchangeRate }));
async function list(path: string, session: Session = h.sessions.admin): Promise<Envelope> {
  const response = await authedGet(path, session);
  expect(response.status).toBe(200);
  return await response.json() as Envelope;
}
async function snapshot() {
  return (await db.query(
    `SELECT to_jsonb(l) AS row FROM lab_orders l WHERE patient_id = ANY($1::integer[]) ORDER BY id`,
    [fixture.patientIds],
  )).rows;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  fixture = await seedPatientLabQuery((sql, values) => db.query(sql, values), `HTTP-PATIENT-LAB-QUERY-${Date.now()}`);
  beforeReads = await snapshot();
}, 120_000);

afterAll(async () => {
  if (db) {
    try {
      if (fixture) {
        // Remove only this synthetic fixture from the harness's disposable database.
        await db.query(`DELETE FROM patients WHERE id = ANY($1::integer[])`, [fixture.patientIds]);
      }
    } finally { await db.end(); }
  }
});

describe("patient lab query through the built HTTP application", () => {
  it("returns older target orders beyond the global 300-row cap with unchanged projection", async () => {
    const global = await list("/api/lab");
    expect(global.orders).toHaveLength(300);
    expect(global.orders.some((order) => fixture.targetOrderIds.includes(order.id))).toBe(false);
    const target = await list(`${queryPath(fixture.targetPatientId)}&services=1`);
    expect(target.orders.map((order) => order.id)).toEqual(fixture.targetOrderIds);
    expect(target.orders.every((order) => order.patientId === fixture.targetPatientId)).toBe(true);
    expect(target.orders.map((order) => order.status)).toEqual(["delivered", "cancelled", "sent"]);
    expect(money(target.orders)).toEqual([...PATIENT_LAB_QUERY_MONEY].reverse());
    expect(target.labs).toEqual(global.labs);
    expect(Array.isArray(target.labServices)).toBe(true);
    expect(global).not.toHaveProperty("labServices");
  });

  it("does not mix another patient's rows and preserves the per-patient 300-row cap", async () => {
    const other = await list(queryPath(fixture.otherPatientId));
    expect(other.orders.map((order) => order.id)).toEqual(fixture.unrelatedOrderIds.slice(0, 300));
    expect(other.orders.every((order) => order.patientId === fixture.otherPatientId)).toBe(true);
    expect((await list(queryPath(fixture.emptyPatientId))).orders).toEqual([]);
  });

  it.each(["", "0", "not-a-number", "1.5", "Infinity"])("preserves global fallback for invalid ID %s", async (id) => {
    const global = await list("/api/lab");
    expect(await list(queryPath(id))).toEqual(global);
  });

  it.each(["-1", "2147483647", "2147483648", "-2147483649", "9007199254740992", "1e100"])(
    "keeps nonmatching integer ID %s empty without query overflow", async (id) => {
      expect((await list(queryPath(id))).orders).toEqual([]);
    },
  );

  it("preserves global summary precedence", async () => {
    const plain = await authedGet("/api/lab?summary=1", h.sessions.admin);
    const scoped = await authedGet(`${queryPath(fixture.targetPatientId)}&summary=1&services=1`, h.sessions.admin);
    expect(plain.status).toBe(200);
    expect(scoped.status).toBe(200);
    expect(await scoped.json()).toEqual(await plain.json());
  });

  it("preserves reception visibility and default doctor cost masking", async () => {
    const path = queryPath(fixture.targetPatientId);
    const admin = await list(path);
    const reception = await list(path, h.sessions.reception);
    expect(reception).toEqual(admin);
    const doctor = await list(path, h.sessions.doctorA);
    expect(doctor).toEqual({ ...admin, orders: admin.orders.map((order) => ({ ...order, costMinor: null, costCurrency: null })) });
  });

  it("preserves explicit doctor cost-price permission without modifying the read policy", async () => {
    const { rows: [user] } = await db.query<{ permissions: string | null }>(
      `SELECT permissions::text AS permissions FROM users WHERE username = $1`, [TEST_USERS.doctorA.username],
    );
    const permissions = user.permissions ? JSON.parse(user.permissions) as Record<string, unknown> : {};
    try {
      await db.query(`UPDATE users SET permissions = $2::jsonb WHERE username = $1`,
        [TEST_USERS.doctorA.username, JSON.stringify({ ...permissions, canViewCostPrices: true })]);
      const path = queryPath(fixture.targetPatientId);
      expect(await list(path, h.sessions.doctorA)).toEqual(await list(path));
    } finally {
      await db.query(`UPDATE users SET permissions = $2::jsonb WHERE username = $1`,
        [TEST_USERS.doctorA.username, user.permissions]);
    }
  });

  it("keeps unauthenticated, portal, cashier, and accountant admission unchanged", async () => {
    const path = queryPath(fixture.targetPatientId);
    const anonymous = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
    expect(anonymous.status).toBe(401);
    expect((await authedGet(path, h.sessions.portalA)).status).toBe(401);
    for (const session of [h.sessions.cashier, h.sessions.accountant]) {
      expect((await authedGet(path, session)).status).toBe(403);
    }
  });

  it("leaves every seeded lab record unchanged across all GET regressions", async () => {
    expect(await snapshot()).toEqual(beforeReads);
  });
});

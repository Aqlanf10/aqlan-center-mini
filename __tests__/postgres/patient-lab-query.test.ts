import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATIENT_LAB_QUERY_MONEY, seedPatientLabQuery } from "../fixtures/patient-lab-query";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
let fixture: Awaited<ReturnType<typeof seedPatientLabQuery>>;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  fixture = await seedPatientLabQuery((sql, values) => db.getPool().query(sql, values), "PG-PATIENT-LAB-QUERY");
});
afterAll(async () => { await db.resetPoolForTesting(); });

describe("canonical patient lab query before order and limit", () => {
  it("selects older target orders even after 301 unrelated rows consume the global cap", async () => {
    const global = await db.listLabOrders();
    expect(global).toHaveLength(300);
    expect(global.every((order) => order.patientId === fixture.otherPatientId)).toBe(true);
    const target = await db.listLabOrders({ patientId: fixture.targetPatientId });
    expect(target.map((order) => order.id)).toEqual(fixture.targetOrderIds);
    expect(target.every((order) => order.patientId === fixture.targetPatientId)).toBe(true);
    expect(target.map((order) => order.status)).toEqual(["delivered", "cancelled", "sent"]);
    expect(target.map(({ costMinor, costCurrency, baseAmountMinor, exchangeRate }) =>
      ({ costMinor, costCurrency, baseAmountMinor, exchangeRate })))
      .toEqual([...PATIENT_LAB_QUERY_MONEY].reverse());
  });

  it("applies patient isolation and the existing per-patient default limit", async () => {
    const other = await db.listLabOrders({ patientId: fixture.otherPatientId });
    expect(other).toHaveLength(300);
    expect(other.map((order) => order.id)).toEqual(fixture.unrelatedOrderIds.slice(0, 300));
    expect(other.every((order) => order.patientId === fixture.otherPatientId)).toBe(true);
    expect(await db.listLabOrders({ patientId: fixture.emptyPatientId })).toEqual([]);
    expect(await db.listLabOrders({ patientId: -1 })).toEqual([]);
  });

  it("preserves canonical custom limit and status-filter composition", async () => {
    expect((await db.listLabOrders({ patientId: fixture.targetPatientId, limit: 1 })).map((order) => order.id))
      .toEqual(fixture.targetOrderIds.slice(0, 1));
    expect((await db.listLabOrders({ patientId: fixture.otherPatientId, limit: 500 })).map((order) => order.id))
      .toEqual(fixture.unrelatedOrderIds);
    expect((await db.listLabOrders({ patientId: fixture.targetPatientId, status: "active" })).map((order) => order.id))
      .toEqual(fixture.targetOrderIds.slice(2));
    expect((await db.listLabOrders({ patientId: fixture.targetPatientId, status: "delivered" })).map((order) => order.id))
      .toEqual(fixture.targetOrderIds.slice(0, 1));
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P2-10) توريد المخزون من مورّدٍ مسجَّل يولد فاتورته في المستحقات — على PostgreSQL 18.
 *
 * العيب (تدقيق الجاهزية): الشراء يُسجَّل في المخزون ثم يُسجَّل يدويًّا مرةً ثانية في
 * المستحقات — أو يُنسى، فتظهر العيادة غير مدينةٍ لمورّدها.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, createInventoryMovement, partyStatement } =
  await import("../../lib/db");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let itemId = 0;
let supplierId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

beforeEach(async () => {
  await q(`TRUNCATE inventory_movements, inventory_items, expense_payable_allocations, expenses, payables, parties
           RESTART IDENTITY CASCADE`);
  [{ id: itemId }] = await q<{ id: number }>(
    `INSERT INTO inventory_items (name, category, unit, min_level, created_by)
     VALUES ('قفازات', 'other', 'علبة', 2, 'test') RETURNING id`,
  );
  [{ id: supplierId }] = await q<{ id: number }>(
    `INSERT INTO parties (name, kind) VALUES ('مورد المستهلكات', 'supplier') RETURNING id`,
  );
});

afterAll(async () => {
  await resetPoolForTesting();
});

const purchase = (extra: Partial<Parameters<typeof createInventoryMovement>[0]> = {}) =>
  createInventoryMovement({
    itemId, kind: "in", qty: 10, createdBy: "reception", unitCostMinor: 2_500,
    supplierPartyId: supplierId, ...extra,
  });

describe("stock purchase from a supplier", () => {
  it("creates the supplier bill (unit cost × qty) in the same transaction and links it", async () => {
    const result = await purchase({ supplierDueDate: "2026-10-31" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.movement.partyId).toBe(supplierId);
    expect(result.movement.payableId).toBeGreaterThan(0);
    const [payable] = await q<{ amount_minor: string; currency: string; category: string; due_date: string; description: string }>(
      `SELECT amount_minor::text, currency, category, due_date::text, description FROM payables WHERE id = $1`,
      [result.movement.payableId],
    );
    expect(payable).toMatchObject({ amount_minor: "25000", currency: "YER", category: "supplier", due_date: "2026-10-31" });
    expect(payable.description).toContain("قفازات");
    const statement = await partyStatement(supplierId);
    expect(statement.payables).toHaveLength(1);
  });

  it("without a supplier nothing is billed, exactly as before", async () => {
    const result = await purchase({ supplierPartyId: null });
    expect(result.ok).toBe(true);
    expect(await q(`SELECT id FROM payables`)).toHaveLength(0);
  });

  it("a supplier without a unit cost is refused and nothing is written", async () => {
    const result = await purchase({ unitCostMinor: null });
    expect(result).toEqual({ ok: false, message: "اكتب ثمن الوحدة لتُسجَّل فاتورة المورّد." });
    expect(await q(`SELECT id FROM inventory_movements`)).toHaveLength(0);
    expect(await q(`SELECT id FROM payables`)).toHaveLength(0);
  });

  it("a doctor party, an unknown party or a return cannot be billed", async () => {
    const [{ id: doctorId }] = await q<{ id: number }>(
      `INSERT INTO parties (name, kind) VALUES ('د. اختبار', 'doctor') RETURNING id`,
    );
    expect((await purchase({ supplierPartyId: doctorId })).ok).toBe(false);
    expect((await purchase({ supplierPartyId: 999_999 })).ok).toBe(false);
    expect((await purchase({ isReturn: true })).ok).toBe(false);
    expect(await q(`SELECT id FROM inventory_movements`)).toHaveLength(0);
    expect(await q(`SELECT id FROM payables`)).toHaveLength(0);
  });
});

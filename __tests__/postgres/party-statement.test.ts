import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * كشف حساب جهة على PostgreSQL 18 الحقيقي.
 *
 * العيب: partyStatement كان يقصّ آخر ٢٠٠ التزام و٢٠٠ سند، والشاشة تجمع
 * «علينا» من المقصوص — فمورّدٌ له ٢٠٥ فواتير يظهر رصيده ناقصًا بصمت.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { ensureSchema, getPool, resetPoolForTesting, createPayable, partyStatement } = await import("../../lib/db");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

beforeEach(async () => {
  await q(`TRUNCATE expense_payable_allocations, expenses, payables, cashier_shifts, parties RESTART IDENTITY CASCADE`);
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("partyStatement", () => {
  it("مورّد بـ٢٠٥ فواتير: الكشف كامل والإجمالي يشملها كلها", async () => {
    const [{ id: partyId }] = await q<{ id: number }>(
      `INSERT INTO parties (name, kind) VALUES ('مورد قديم', 'supplier') RETURNING id`,
    );
    for (let index = 0; index < 205; index += 1) {
      await createPayable({
        partyId, category: "supplier", description: `فاتورة ${index + 1}`, amountMinor: 1_000, currency: "YER",
        baseCurrency: "YER", exchangeRate: 1, labOrderId: null, dueDate: null, createdBy: "test",
      });
    }
    const statement = await partyStatement(partyId);
    expect(statement.payables).toHaveLength(205);
    expect(statement.totals).toEqual([
      { currency: "YER", owedMinor: 205_000, settledMinor: 0, remainingMinor: 205_000, paidMinor: 0, unlinkedPaidMinor: 0 },
    ]);
  });

  it("فاتورة بالدولار وأخرى بالريال: سطران بعملتيهما لا مكافئٌ ممزوج", async () => {
    const [{ id: partyId }] = await q<{ id: number }>(
      `INSERT INTO parties (name, kind) VALUES ('مختبر مختلط', 'lab') RETURNING id`,
    );
    await createPayable({
      partyId, category: "lab", description: "زيركون", amountMinor: 10_000, currency: "USD",
      baseCurrency: "YER", exchangeRate: 530, labOrderId: null, dueDate: null, createdBy: "test",
    });
    await createPayable({
      partyId, category: "lab", description: "تركيبة", amountMinor: 40_000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, labOrderId: null, dueDate: null, createdBy: "test",
    });
    const { totals } = await partyStatement(partyId);
    expect(totals.map((row) => [row.currency, row.owedMinor, row.remainingMinor])).toEqual([
      ["YER", 40_000, 40_000],
      ["USD", 10_000, 10_000],
    ]);
  });
});

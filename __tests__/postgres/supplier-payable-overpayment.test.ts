import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * P0-2 — مدفوعات الموردين والمختبرات على PostgreSQL 18 الحقيقي.
 *
 * الحالات الأولى إعادة إنتاجٍ حرفية لما أثبته تدقيق الجاهزية:
 *   التزام ٥٠٬٠٠٠ ← سند ٢٠٬٠٠٠ ← سند ٩٩٩٬٩٩٩ على الالتزام نفسه قُبل (201)،
 *   وإبطال سند التزامٍ رُفض بلا أي مسار تصحيح.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { ensureSchema, getPool, recordExpense, resetPoolForTesting, voidExpense, createPayable } = db;

type Currency = "YER" | "SAR" | "USD";

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function party(name: string, kind: "lab" | "supplier" | "doctor" = "supplier"): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO parties (name, kind) VALUES ($1, $2) RETURNING id`, [name, kind],
  );
  return row.id;
}

async function bill(partyId: number, amount: number, currency: Currency = "YER", rate = 1): Promise<number> {
  const payable = await createPayable({
    partyId, category: "supplier", description: "فاتورة مورد", amountMinor: amount, currency,
    baseCurrency: "YER", exchangeRate: rate, labOrderId: null, dueDate: null, createdBy: "test",
  });
  return payable!.id;
}

async function payOut(input: {
  partyId: number | null; payableId?: number | null; amount: number; currency?: Currency; rate?: number;
}) {
  return recordExpense({
    category: "supplier", partyId: input.partyId, payeeText: null, amountMinor: input.amount,
    currency: input.currency ?? "YER", baseCurrency: "YER", exchangeRate: input.rate ?? 1,
    payableId: input.payableId ?? null, note: null, createdBy: "test",
  });
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

beforeEach(async () => {
  // TRUNCATE لا يطلق حرّاس الصفوف (append-only) — تنظيف قاعدة اختبارٍ معزولة فقط.
  await q(`TRUNCATE expenses, payables, lab_order_tracking, lab_orders, patients, cashier_shifts,
                    parties, audit_log RESTART IDENTITY CASCADE`);
  await q(`INSERT INTO cashier_shifts (opened_by) VALUES ('p02')`);
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("إعادة إنتاج عيوب تدقيق الجاهزية (P0-2) — يجب ألا تعود أبدًا", () => {
  it("AUDIT-P02-1: سند ٩٩٩٬٩٩٩ على التزامٍ متبقّيه ٣٠٬٠٠٠ يُرفض ولا يُسجَّل", async () => {
    const s = await party("مورد أ");
    const b = await bill(s, 50_000);
    const first = await payOut({ partyId: s, payableId: b, amount: 20_000 });
    expect(first.expense).not.toBeNull();

    const second = await payOut({ partyId: s, payableId: b, amount: 999_999 });
    expect(second.expense).toBeNull();
    expect(second.reason).toBe("exceeds_payable");
    const [{ n }] = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM expenses`);
    expect(n).toBe(1);
  });

  it("AUDIT-P02-2: سند يسدّد التزامًا يُصحَّح بقيدٍ معاكس — لا طريق مسدود", async () => {
    const s = await party("مورد ب");
    const b = await bill(s, 50_000);
    const paid = await payOut({ partyId: s, payableId: b, amount: 20_000 });
    const result = await voidExpense(paid.expense!.id, { actor: "admin", actorRole: "admin", reason: "خطأ إدخال" });
    expect(result.ok).toBe(true);
    const [{ net }] = await q<{ net: string }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::text AS net FROM expenses WHERE payable_id = $1`, [b],
    );
    expect(Number(net)).toBe(0);
  });

  it("AUDIT-P02-3: سند صرف عادي لمورد فوق رصيده المستحق يُرفض (قرار المالك: امنع دائمًا)", async () => {
    const s = await party("مورد ج");
    await bill(s, 50_000);
    const over = await payOut({ partyId: s, amount: 999_999 });
    expect(over.expense).toBeNull();
    expect(over.reason).toBe("exceeds_party_balance");
  });
});

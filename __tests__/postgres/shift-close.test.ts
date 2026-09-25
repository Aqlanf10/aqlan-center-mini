import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1-3) إقفال الوردية على PostgreSQL 18 الحقيقي.
 *
 * AUDIT-P13-1/2 إعادة إنتاجٍ حرفية أُثبت فشلها على main قبل الإصلاح:
 *   تحويلٌ لم يدخل الدرج رُحّل «عجز جرد» (خسارة وهمية)، ووردية بعجز ١٠٬٠٠٠ أُقفلت بلا سبب.
 */
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const { ensureSchema, getPool, recordPayment, recordExpense, closeShift, journalEntries, resetPoolForTesting, CLINIC_TIME_ZONE, listShifts, getShift } = db;
const { SHIFT_CLOSE_SQL } = await import("../../lib/shift-close-schema");
const { clinicDateString } = await import("../../lib/schedule");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
let patientId = 0;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});
beforeEach(async () => {
  // TRUNCATE لا يطلق حرّاس الصفوف — تنظيف قاعدة اختبارٍ معزولة فقط.
  await q(`TRUNCATE payments, expenses, cashier_shifts, patients RESTART IDENTITY CASCADE`);
  const [p] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('Z-1', 'مريض الجرد') RETURNING id`);
  patientId = p.id;
});
afterAll(async () => { await resetPoolForTesting(); });

async function openWith(cash: number, transfer: number, opening = 0): Promise<number> {
  const [shift] = await q<{ id: number }>(
    `INSERT INTO cashier_shifts (opened_by, opening_yer) VALUES ('repro', $1) RETURNING id`, [opening],
  );
  for (const [amount, method] of [[cash, "cash"], [transfer, "transfer"]] as const) {
    if (amount === 0) continue;
    await recordPayment({
      patientId, invoiceId: null, planId: null, kind: "payment", amountMinor: amount, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, method, note: null, createdBy: "repro",
    } as never);
  }
  return shift.id;
}

describe("P1-3 — إعادة إنتاج عيوب تدقيق الجاهزية", () => {
  it("AUDIT-P13-1: التحويل لا يُرحَّل «عجز جرد» حين يطابق المعدودُ النقدَ الفعلي", async () => {
    const id = await openWith(10_000, 5_000);
    await (closeShift as (input: unknown) => Promise<unknown>)({
      id, closedBy: "repro", counted: { YER: 10_000, SAR: 0, USD: 0 }, note: null,
    });
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const fake = (await journalEntries(today, today)).filter((entry) => entry.source === "cash_diff");
    expect(fake).toEqual([]);
  });

  it("AUDIT-P13-2: جردٌ ناقص (عجز ١٠٬٠٠٠) لا يُقفَل بلا سبب", async () => {
    const id = await openWith(10_000, 0);
    await (closeShift as (input: unknown) => Promise<unknown>)({
      id, closedBy: "repro", counted: { YER: 0, SAR: 0, USD: 0 }, note: null,
    });
    const [row] = await q<{ status: string }>(`SELECT status FROM cashier_shifts WHERE id = $1`, [id]);
    expect(row.status).toBe("open");
  });
});

const Z = { YER: 0, SAR: 0, USD: 0 };

describe("P1-3 — الإقفال الأعمى والمتوقَّع المحفوظ", () => {
  it("CASE 1: المتوقَّع = افتتاحي + نقد − مردود نقدي − صرف؛ التحويل خارجه؛ والجرد المطابق يُقفَل بلا سبب", async () => {
    const id = await openWith(10_000, 5_000, 1_000);
    await recordExpense({
      category: "other", partyId: null, payeeText: "نثريات", amountMinor: 2_000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, payableId: null, note: null, createdBy: "t",
    });
    const result = await closeShift({ id, closedBy: "t", counted: { ...Z, YER: 9_000 }, note: null });
    expect(result.reason).toBeNull();
    expect(result.breakdown!.expected.YER).toBe(9_000);
    expect(result.breakdown!.nonCashIn.YER).toBe(5_000);
    const [row] = await q<{ expected_yer: string; difference_yer: string; difference_reason: string | null }>(
      `SELECT expected_yer, difference_yer, difference_reason FROM cashier_shifts WHERE id = $1`, [id],
    );
    expect(Number(row.expected_yer)).toBe(9_000);
    expect(Number(row.difference_yer)).toBe(0);
    expect(row.difference_reason).toBeNull();
    expect((await getShift(id))!.difference).toEqual(Z);
  });

  it("CASE 2: العجز يُرفض بلا سبب ويُعاد مقداره، ثم يُقفَل بسببه ويُحفظ", async () => {
    const id = await openWith(10_000, 0);
    const refused = await closeShift({ id, closedBy: "t", counted: { ...Z, YER: 9_500 }, note: null });
    expect(refused.reason).toBe("difference_reason_required");
    expect(refused.difference!.YER).toBe(-500);
    const closed = await closeShift({
      id, closedBy: "t", counted: { ...Z, YER: 9_500 }, note: null, differenceReason: "باقي مريض لم يُعَد",
    });
    expect(closed.reason).toBeNull();
    expect(closed.shift!.difference!.YER).toBe(-500);
    expect(closed.shift!.differenceReason).toBe("باقي مريض لم يُعَد");
    expect(closed.shift!.expectedSource).toBe("stored");
  });

  it("CASE 3: الوردية المقفلة لا تُعدَّل — حتى من psql", async () => {
    const id = await openWith(1_000, 0);
    await closeShift({ id, closedBy: "t", counted: { ...Z, YER: 1_000 }, note: null });
    await expect(q(`UPDATE cashier_shifts SET counted_yer = 999999 WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    await expect(q(`UPDATE cashier_shifts SET status = 'open' WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
  });

  it("CASE 4: القيد البنيوي — فرقٌ غير صفري بلا سبب مرفوض من القاعدة نفسها", async () => {
    const id = await openWith(1_000, 0);
    await expect(q(
      `UPDATE cashier_shifts SET status = 'closed', closed_at = NOW(), counted_yer = 0, expected_yer = 1000, difference_yer = -1000
        WHERE id = $1`, [id],
    )).rejects.toThrow(/cashier_shifts_difference_needs_reason/);
  });

  it("CASE 5: وردية أُقفلت قبل 0014 (بلا متوقَّع محفوظ) — يُحسب بالقاعدة نفسها ويوسَم «محسوب»", async () => {
    const id = await openWith(10_000, 5_000);
    await q(`UPDATE cashier_shifts SET status = 'closed', closed_at = NOW(), counted_yer = 9_000, counted_sar = 0, counted_usd = 0
              WHERE id = $1`, [id]);
    const [shift] = (await listShifts(5)).filter((row) => row.id === id);
    expect(shift.expectedSource).toBe("computed");
    expect(shift.expected.YER).toBe(10_000);
    expect(shift.difference!.YER).toBe(-1_000);
  });

  it("CASE 6: سند صرف أثناء إقفالٍ جارٍ ينتظره ثم يُرفض — لا يدخل ورديةً أُقفل جردها", async () => {
    const id = await openWith(1_000, 0);
    const locker = await getPool().connect();
    try {
      await locker.query("BEGIN");
      await locker.query(`SELECT id FROM cashier_shifts WHERE id = $1 FOR UPDATE`, [id]);
      const pending = recordExpense({
        category: "other", partyId: null, payeeText: "أثناء الإقفال", amountMinor: 100, currency: "YER",
        baseCurrency: "YER", exchangeRate: 1, payableId: null, note: null, createdBy: "t",
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await locker.query(
        `UPDATE cashier_shifts SET status = 'closed', closed_at = NOW(), counted_yer = 1000, counted_sar = 0, counted_usd = 0,
                expected_yer = 1000, expected_sar = 0, expected_usd = 0, difference_yer = 0, difference_sar = 0, difference_usd = 0
          WHERE id = $1`, [id],
      );
      await locker.query("COMMIT");
      const result = await pending;
      expect(result.reason).toBe("no_shift");
      const [{ n }] = await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM expenses WHERE shift_id = $1`, [id]);
      expect(n).toBe(0);
    } finally {
      locker.release();
    }
  });

  it("CASE 7: قيد التحويل في حساب البنك لا الصندوق", async () => {
    await openWith(0, 5_000);
    const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
    const entries = await journalEntries(today, today);
    const receipt = entries.find((entry) => entry.source === "payment")!;
    expect(receipt.lines.find((line) => line.side === "debit")!.accountCode).toBe("1111");
  });

  it("CASE 8: مسارا المخطط — التكرار لا يغيّر شيئًا", async () => {
    await q(SHIFT_CLOSE_SQL);
    await q(SHIFT_CLOSE_SQL);
    const [{ n }] = await q<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = 'cashier_shifts_closed_guard'`,
    );
    expect(n).toBe(1);
  });
});

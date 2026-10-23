import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

/**
 * FIN-INT legacy balances: a manual correction never invents a credit or orphans receipts.
 * Lowering a legacy balance below the net receipts settled against it, or deleting a balance
 * any receipt references (even a refunded one), is refused under the writer's own locks.
 * The dry run applies the same rule from a read-only snapshot and writes nothing.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_opening_correction_guard_test");
const db = await import("../../lib/db");

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let serial = 0;

beforeAll(async () => {
  await db.ensureSchema();
  await db.openShift({ openedBy: "synthetic-cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function patientWithOpening(amountMinor: number) {
  serial += 1;
  const [{ id }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic legacy balance') RETURNING id`, [`OPN-G-${serial}`]);
  await db.setPatientOpeningBalance({ patientId: id, currency: "YER", amountMinor, asOfDate: "2026-01-01", note: null,
    createdBy: "synthetic-admin", reason: null, addOnly: false, expectedBefore: null });
  return id;
}

async function receipt(patientId: number, kind: "payment" | "refund", amountMinor: number, reversalOfId?: number): Promise<number> {
  serial += 1;
  const result = await db.recordPayment({ patientId, invoiceId: null, openingCurrency: "YER", kind, amountMinor, currency: "YER",
    baseCurrency: "YER", exchangeRate: 1, method: "cash", note: kind === "refund" ? "Synthetic refund" : null, createdBy: "synthetic-cashier",
    idempotencyKey: `opening-guard-${serial}`, ...(reversalOfId ? { reversalOfId } : {}) } as Parameters<typeof db.recordPayment>[0]);
  expect(result).toMatchObject({ payment: { openingCurrency: "YER", kind, amountMinor } });
  return result.payment!.id;
}

const state = async (patientId: number) => ({
  openings: await q(`SELECT amount_minor::int AS amount FROM patient_opening_balances WHERE patient_id = $1`, [patientId]),
  history: (await q<{ n: number }>(`SELECT count(*)::int AS n FROM patient_opening_balance_history WHERE patient_id = $1`, [patientId]))[0].n,
});

const correct = (patientId: number, amountMinor: number, beforeMinor: number) => db.setPatientOpeningBalance({
  patientId, currency: "YER", amountMinor, asOfDate: "2026-01-01", note: null, createdBy: "synthetic-admin",
  reason: "Synthetic correction", addOnly: false, expectedBefore: { amountMinor: beforeMinor, asOfDate: "2026-01-01" } });

describe("FIN-INT legacy balance correction guard", () => {
  it("refuses lowering a balance below its settled receipts; the dry run says so first and writes nothing", async () => {
    const patientId = await patientWithOpening(100_000);
    await receipt(patientId, "payment", 60_000);
    const before = await state(patientId);
    const preview = await db.previewOpeningCorrection(patientId, "YER", 40_000);
    expect(preview).toMatchObject({ currentAmountMinor: 100_000, settledMinor: 60_000, receiptCount: 1, afterAmountMinor: 40_000,
      currentRemainingMinor: 40_000, afterRemainingMinor: 0, allowed: false, code: "below_settled" });
    expect(await state(patientId)).toEqual(before);
    await expect(correct(patientId, 40_000, 100_000)).rejects.toMatchObject({ code: "below_settled" });
    expect(await state(patientId)).toEqual(before);
  });

  it("allows a correction that still covers the settled receipts, down to exactly the settled amount", async () => {
    const patientId = await patientWithOpening(100_000);
    await receipt(patientId, "payment", 60_000);
    expect(await db.previewOpeningCorrection(patientId, "YER", 60_000)).toMatchObject({ allowed: true, afterRemainingMinor: 0 });
    expect(await correct(patientId, 60_000, 100_000)).toMatchObject({ amountMinor: 60_000 });
    expect((await state(patientId)).openings).toEqual([{ amount: 60_000 }]);
  });

  it("nets refunds: a refund restores room to lower the balance", async () => {
    const patientId = await patientWithOpening(100_000);
    await receipt(patientId, "refund", 20_000, await receipt(patientId, "payment", 60_000));
    expect(await db.previewOpeningCorrection(patientId, "YER", 40_000)).toMatchObject({ settledMinor: 40_000, receiptCount: 2, allowed: true });
    expect(await correct(patientId, 40_000, 100_000)).toMatchObject({ amountMinor: 40_000 });
  });

  it("refuses deleting a balance that any receipt references, even when payment and refund net to zero", async () => {
    const patientId = await patientWithOpening(50_000);
    await receipt(patientId, "refund", 10_000, await receipt(patientId, "payment", 10_000));
    const before = await state(patientId);
    expect(await db.previewOpeningCorrection(patientId, "YER", null)).toMatchObject({ settledMinor: 0, receiptCount: 2,
      afterAmountMinor: null, allowed: false, code: "receipts_reference_opening" });
    await expect(db.clearPatientOpeningBalance(patientId, "synthetic-admin", "Synthetic deletion", "YER", { amountMinor: 50_000, asOfDate: "2026-01-01" }))
      .rejects.toMatchObject({ code: "receipts_reference_opening" });
    expect(await state(patientId)).toEqual(before);
  });

  it("still deletes a pristine balance and keeps its history", async () => {
    const patientId = await patientWithOpening(50_000);
    expect(await db.previewOpeningCorrection(patientId, "YER", null)).toMatchObject({ receiptCount: 0, allowed: true });
    expect(await db.clearPatientOpeningBalance(patientId, "synthetic-admin", "Synthetic deletion", "YER", { amountMinor: 50_000, asOfDate: "2026-01-01" })).toBe(true);
    expect(await state(patientId)).toEqual({ openings: [], history: 2 });
  });

  it("reception's add-only path is unchanged", async () => {
    serial += 1;
    const [{ id }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic add') RETURNING id`, [`OPN-G-${serial}`]);
    expect(await db.setPatientOpeningBalance({ patientId: id, currency: "SAR", amountMinor: 5_000, asOfDate: "2026-01-01", note: null,
      createdBy: "synthetic-reception", reason: null, addOnly: true, expectedBefore: null })).toMatchObject({ amountMinor: 5_000 });
  });
});

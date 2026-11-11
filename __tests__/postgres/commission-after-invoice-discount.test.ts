/** Owner decision 2026-11-11 (finance point 1): the doctor's percentage is taken after the invoice
 * discount. Real PostgreSQL, synthetic data. The discount is spread over the invoice lines exactly,
 * per invoice currency; two doctors on one invoice never share more than was collected. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { Currency } from "../../lib/money";

validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
process.env.SESSION_SECRET ??= "synthetic-commission-discount-only";
const db = await import("../../lib/db");
const FROM = "2026-10-01", TO = "2026-10-31", AT = "2026-10-05T07:00:00Z";
let seq = 0;
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
const id = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;
const doctor = (percent: number) => db.createParty({ name: `SYN discount doctor ${++seq}`, kind: "doctor", phone: null, commissionPercent: percent, note: null });
const patient = () => id("INSERT INTO patients(patient_number,full_name) VALUES($1,'SYN discount patient') RETURNING id", [`SYN-DISC-${++seq}`]);
/** One invoice; each line is [doctorId or null, amount]. */
async function invoice(patientId: number, lines: [number | null, number][], discount: number, currency: Currency = "YER") {
  const total = lines.reduce((sum, [, amount]) => sum + amount, 0);
  const invoiceId = await id(`INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,created_by,created_at)
    VALUES($1,$2,$3,$4,$5,'SYN-admin',$6) RETURNING id`, [`SYN-DISC-I-${++seq}`, patientId, total, discount, currency, AT]);
  for (const [doctorId, amount] of lines) {
    await q(`INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor,doctor_id) VALUES($1,$2,1,$3,$3,$4)`,
      [invoiceId, `SYN line ${++seq}`, amount, doctorId]);
  }
  return invoiceId;
}
async function pay(patientId: number, invoiceId: number, amount: number, currency: Currency = "YER") {
  const result = await db.recordPayment({ patientId, invoiceId, kind: "payment", amountMinor: amount, currency, baseCurrency: "YER",
    exchangeRate: currency === "YER" ? 1 : 500, method: "cash", createdBy: "SYN-admin", note: "SYN discount", reversalOfId: null });
  expect(result.reason).toBeNull();
  await q("UPDATE payments SET created_at='2026-10-10T07:00:00Z' WHERE id=$1", [result.payment!.id]);
}
const rowOf = async (doctorId: number, currency: Currency = "YER") =>
  (await db.commissionReport(FROM, TO)).find(row => row.doctorId === doctorId && row.currency === currency);

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  await id("INSERT INTO cashier_shifts(opened_by) VALUES('SYN-admin') RETURNING id");
});
afterAll(async () => { await db.resetPoolForTesting(); });

describe("commission is taken after the invoice discount", () => {
  it("one doctor: 40% of the 80,000 collected is 32,000, not 40,000", async () => {
    const d = await doctor(40), p = await patient();
    const inv = await invoice(p, [[d.id, 100_000]], 20_000);
    await pay(p, inv, 80_000);
    expect(await rowOf(d.id)).toMatchObject({ accruedMinor: 32_000, earnedMinor: 32_000 });
  });

  it("two doctors on one invoice share the discount in proportion; a part payment earns in proportion", async () => {
    const a = await doctor(40), b = await doctor(50), p = await patient();
    const inv = await invoice(p, [[a.id, 60_000], [b.id, 40_000]], 20_000);
    await pay(p, inv, 40_000);
    // Bases 48,000 and 32,000 (they add up to the 80,000 net); half collected.
    expect(await rowOf(a.id)).toMatchObject({ accruedMinor: 19_200, earnedMinor: 9_600 });
    expect(await rowOf(b.id)).toMatchObject({ accruedMinor: 16_000, earnedMinor: 8_000 });
  });

  it("a line without a doctor takes its part of the discount: the doctor is not charged for it", async () => {
    const d = await doctor(50), p = await patient();
    const inv = await invoice(p, [[d.id, 30_000], [null, 70_000]], 10_000);
    await pay(p, inv, 90_000);
    // The doctor's line carries 3,000 of the 10,000 discount: base 27,000.
    expect(await rowOf(d.id)).toMatchObject({ accruedMinor: 13_500, earnedMinor: 13_500 });
  });

  it("odd units go to the largest remainder and the bases still add up to the net", async () => {
    const a = await doctor(100), b = await doctor(100), c = await doctor(100), p = await patient();
    const inv = await invoice(p, [[a.id, 10_000], [b.id, 10_000], [c.id, 10_000]], 1_000);
    await pay(p, inv, 29_000);
    const earned = [(await rowOf(a.id))!.earnedMinor, (await rowOf(b.id))!.earnedMinor, (await rowOf(c.id))!.earnedMinor];
    expect(earned).toEqual([9_666, 9_667, 9_667]);
    expect(earned.reduce((sum, value) => sum + value, 0)).toBe(29_000);
  });

  it("each currency keeps its own discount and its own bucket; an undiscounted invoice is unchanged", async () => {
    const d = await doctor(30), p = await patient();
    const usd = await invoice(p, [[d.id, 10_000]], 2_500, "USD");
    const yer = await invoice(p, [[d.id, 10_000]], 0, "YER");
    await pay(p, usd, 7_500, "USD");
    await pay(p, yer, 10_000, "YER");
    expect(await rowOf(d.id, "USD")).toMatchObject({ accruedMinor: 2_250, earnedMinor: 2_250 });
    expect(await rowOf(d.id, "YER")).toMatchObject({ accruedMinor: 3_000, earnedMinor: 3_000 });
  });
});

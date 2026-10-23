import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import type { Currency } from "../../lib/money";

assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
let session: SessionPayload, serial = 0;
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;

// Fixed instants around one Asia/Aden midnight (UTC+3, no DST). Nothing here reads the wall clock.
const RECEIPT_AT = "2026-03-10T23:59:30+03:00";
const SAME_DAY_ARRIVAL = "2026-03-10T23:59:50+03:00";
const NEXT_DAY_ARRIVAL = "2026-03-11T00:00:10+03:00";

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-clinic-day");
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('clinic-day','Synthetic clinic day',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "clinic-day", role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: auth.sessionCredentialVersion(hash) };
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function invoice(patientId: number, currency: Currency, amountMinor: number) {
  const created = await db.createInvoice({ patientId, baseCurrency: currency, discountMinor: 0, note: null, createdBy: session.username,
    items: [{ serviceId: null, doctorId: null, description: "Synthetic clinic-day item", quantity: 1, unitPriceMinor: amountMinor }] });
  if (!created) throw new Error("Synthetic invoice failed");
  return created.id;
}
async function receipt(patientId: number, invoiceId: number, amountMinor: number) {
  const result = await db.recordPayment({ patientId, invoiceId, kind: "payment", amountMinor, currency: "USD", baseCurrency: "YER",
    exchangeRate: 530, method: "cash", note: null, createdBy: session.username, idempotencyKey: `clinic-day-${++serial}` });
  expect(result.reason).toBeNull(); if (!result.payment) throw new Error("Synthetic payment failed");
  await q("UPDATE payments SET created_at=$2 WHERE id=$1", [result.payment.id, RECEIPT_AT]);
}

/** The td05 shape: USD 500 prior + USD 1,500 earlier visit, paid 2,000 USD; today's visit invoices USD 1,500. */
async function scenario() {
  const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic clinic day') RETURNING id", [`CLINIC-DAY-${++serial}`]))[0].id as number;
  const prior = await invoice(patientId, "USD", 50000), earlier = await invoice(patientId, "USD", 150000);
  await invoice(patientId, "YER", 2500000); await invoice(patientId, "SAR", 180000);
  await receipt(patientId, prior, 50000); await receipt(patientId, earlier, 150000);
  const today = await invoice(patientId, "USD", 150000);
  const visitId = (await q(`INSERT INTO visits(patient_id,patient_name,status,arrived_at,signed_at,invoice_id)
    VALUES($1,'Synthetic clinic day','done',$2,$2,$3) RETURNING id`, [patientId, SAME_DAY_ARRIVAL, today]))[0].id as number;
  return { visitId };
}
async function walkout(visitId: number) { const value = await db.visitWalkout(visitId); if (!value) throw new Error("Synthetic walkout missing"); return value; }

describe("visit checkout prior reference across the clinic-day boundary", () => {
  it("same clinic day: the day's USD receipts stay out of the prior reference", async () => {
    const { visitId } = await scenario(), value = await walkout(visitId);
    expect(value.checkout.previous).toEqual({ YER: 2500000, SAR: 180000, USD: 200000 });
    expect(value.checkout.current).toEqual({ YER: 2500000, SAR: 180000, USD: 150000 });
    expect(value.checkout.paymentsToday).toEqual([{ currency: "USD", netMinor: 200000 }]);
  });

  it("adjacent clinic day: the same receipts become prior and net the USD reference to zero", async () => {
    const { visitId } = await scenario();
    await q("UPDATE visits SET arrived_at=$2 WHERE id=$1", [visitId, NEXT_DAY_ARRIVAL]);
    const value = await walkout(visitId);
    expect(value.checkout.previous).toEqual({ YER: 2500000, SAR: 180000, USD: 0 });
    expect(value.checkout.current).toEqual({ YER: 2500000, SAR: 180000, USD: 150000 });
    expect(value.checkout.paymentsToday).toEqual([]);
  });
});

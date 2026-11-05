/** M2 slice 90a (G4-4): the day's receipts on the canonical runtime, real PostgreSQL,
 * synthetic data only. finance.payments.view; rows only inside the patient scope; the
 * invoice and ledger grants never substitute; the body equals the legacy reader for an
 * `all` scope; revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-payment-day-secret-90");
const db = await import("../../lib/db");
const reads = await import("../../lib/canonical-payment-reads");

const ACCOUNTS = {
  owner: { username: "SYN-PD-OWNER", role: "admin" },
  cashier: { username: "SYN-PD-CASH", role: "cashier", patientScope: "all", grants: { "finance.payments.view": true } },
  invoices: { username: "SYN-PD-INV", role: "accountant", patientScope: "all", grants: { "finance.invoices.view": true, "finance.patient-ledger.view": true } },
  doctor: { username: "SYN-PD-DR", role: "doctor", doctor: true, patientScope: "own", grants: { "finance.payments.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { message?: string }) => error);
const denied = { message: expect.stringMatching(/CAPABILITY_DENIED$/) };
const ids = { mine: 0, other: 0 };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: db.CLINIC_TIME_ZONE }).format(new Date());

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  await db.openShift({ openedBy: "SYN-PD-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
  ids.mine = (await q("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ('SYN-PD-1','SYN PD mine',$1) RETURNING id", [fx.parties.doctor]))[0].id;
  ids.other = (await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-PD-2','SYN PD other') RETURNING id"))[0].id;
  for (const [patientId, amount, key] of [[ids.mine, 1100, "a"], [ids.other, 2200, "b"]] as const) {
    const made = await db.recordPayment({ patientId, invoiceId: null, openingCurrency: null, amountMinor: amount, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, kind: "payment", method: "cash", note: null, createdBy: "SYN", idempotencyKey: `syn-pd-${key}-0001` });
    expect(made.reason).toBeNull();
  }
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("day receipts", () => {
  it("finance.payments.view with scope all reads the legacy day list", async () => {
    const read = await reads.readCanonicalDayPayments(await fx.session("cashier"), today());
    expect(JSON.parse(JSON.stringify(read))).toEqual(JSON.parse(JSON.stringify({ date: today(), payments: await db.listPaymentsByDate(today()) })));
    expect(read.payments.map(row => row.patientId).sort()).toEqual([ids.mine, ids.other].sort());
  });

  it("an own scope keeps only its patients' receipts, revealing nothing of the others", async () => {
    const read = await reads.readCanonicalDayPayments(await fx.session("doctor"), today());
    expect(read.payments.map(row => row.patientId)).toEqual([ids.mine]);
    expect(JSON.stringify(read)).not.toContain("SYN PD other");
    expect(JSON.stringify(read)).not.toContain("2200");
  });

  it("refused without the payments view (invoice and ledger grants never substitute); revocation", async () => {
    expect(await refusal(reads.readCanonicalDayPayments(await fx.session("invoices"), today()))).toMatchObject(denied);
    await fx.setGrants("cashier", {}, { patientScope: "all" });
    try {
      expect(await refusal(reads.readCanonicalDayPayments(await fx.session("cashier"), today()))).toMatchObject(denied);
    } finally { await fx.setGrants("cashier", { "finance.payments.view": true }, { patientScope: "all" }); }
  });
});

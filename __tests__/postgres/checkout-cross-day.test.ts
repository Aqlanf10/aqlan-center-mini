import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db");
const { visitCheckoutSummary } = await import("../../lib/checkout-db");
const { createLegacyBalanceArrangement } = await import("../../lib/legacy-balance-arrangements-db");
const { clinicDateString, addDays } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE), yesterday = addDays(today, -1);
beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  expect(["127.0.0.1", "localhost"]).toContain(url.hostname); expect(url.pathname).toBe("/aqlan_p1_test");
  await dropPublicSchema(url.toString()); await db.ensureSchema();
  await db.openShift({ openedBy: "synthetic-manager", opening: { YER: 0, SAR: 0, USD: 0 } });
});
afterAll(async () => { await db.resetPoolForTesting(); });
it.each(["today", "yesterday"])("yesterday's visit preserves its arrival-day reference and uses current-day installments: receipt %s", async receiptDay => {
  const patient = await db.getPool().query<{id:number}>(`INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض اصطناعي') RETURNING id`, [`CROSS-${receiptDay}`]);
  const patientId = patient.rows[0].id;
  await db.setPatientOpeningBalance({ patientId, currency: "YER", amountMinor: 110000, asOfDate: yesterday, note: null, createdBy: "synthetic-manager", reason: null });
  expect((await createLegacyBalanceArrangement({ patientId, currency: "YER", cadence: "per_visit", installmentMinor: 10000, firstDueDate: null, note: null, createdBy: "synthetic-manager", today: yesterday })).ok).toBe(true);
  const visit = await db.addVisit({ patientId, patientName: "مريض اصطناعي", patientPhone: null, note: null });
  await db.getPool().query(`UPDATE visits SET arrived_at = ($2::date + time '10:00') AT TIME ZONE $3 WHERE id = $1`, [visit.id, yesterday, db.CLINIC_TIME_ZONE]);
  const paid = await db.recordPayment({ patientId, invoiceId: null, openingCurrency: "YER", kind: "payment", amountMinor: 10000, currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: "سند اصطناعي", createdBy: "synthetic-manager" });
  expect(paid.reason).toBeNull();
  if (receiptDay === "yesterday") await db.getPool().query(`UPDATE payments SET created_at = ($2::date + time '11:00') AT TIME ZONE $3 WHERE id = $1`, [paid.payment!.id, yesterday, db.CLINIC_TIME_ZONE]);
  const before = await db.patientLedger(patientId);
  const walkout = (await db.visitWalkout(visit.id))!;
  const [line] = await visitCheckoutSummary(walkout);
  expect(line.currentBalanceMinor).toBe(100000);
  // Narrative remains the original visit day; actionable summary uses the server's current clinic day.
  expect(walkout.payments.map(p => p.receiptNumber)).toEqual(receiptDay === "today" ? [] : [paid.payment!.receiptNumber]);
  // PREVIOUS_BALANCE_LABEL / NOTE exclude the visit invoice and arrival-day receipts,
  // not financial-read-day receipts; this is a live ledger reference, not a signature snapshot.
  const arrivalDayReference = receiptDay === "today" ? 100000 : 110000;
  expect(walkout.checkout.previous.YER).toBe(arrivalDayReference);
  expect(line.previousBalanceMinor).toBe(arrivalDayReference);
  expect(line.legacySuggestedMinor).toBe(receiptDay === "today" ? 0 : 10000);
  expect(line.paymentsTodayMinor).toBe(receiptDay === "today" ? 10000 : 0);
  expect(await db.patientLedger(patientId)).toEqual(before);
});

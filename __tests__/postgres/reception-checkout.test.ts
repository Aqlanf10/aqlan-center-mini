import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P0-G) الشبّاك بعد التوقيع على PostgreSQL 18 — مريض التقويم السابق: رصيدٌ قديم ٣٥٠ ألفًا وترتيب ٣٠ ألفًا،
 * دفع القسط اليوم على opening_currency، وحشوة جديدة ١٥ ألفًا ⇒ السطر «مستحق جديد»، السابق ٣٥٠ ألفًا،
 * الحالي ٣٣٥ ألفًا، ولا قسطٌ مقترح ثانٍ اليوم، والمطلوب الآن ١٥ ألفًا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, addVisit, setVisitProcedures, signClinicalVisit,
  recordPayment, setPatientOpeningBalance, visitWalkout, deferVisitPayment,
} = db;
const { createLegacyBalanceArrangement } = await import("../../lib/legacy-balance-arrangements-db");
const { visitCheckoutSummary } = await import("../../lib/checkout-db");
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctorId = 0;
let fillingId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  doctorId = (await q<{ id: number }>(`INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', 'د. عقلان', 30) RETURNING id`))[0].id;
  fillingId = (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('حشوة', 15000, TRUE, TRUE, 'filling') RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(P0-G) reception checkout after the doctor signs", () => {
  it("classifies today's work and summarizes money per currency from the canonical engine", async () => {
    const patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('CHK-1', 'مريض الشبّاك') RETURNING id`))[0].id;
    await setPatientOpeningBalance({ patientId, currency: "YER", amountMinor: 350_000, asOfDate: today, note: null, createdBy: "m", reason: null });
    expect((await createLegacyBalanceArrangement({
      patientId, currency: "YER", cadence: "per_visit", installmentMinor: 30_000, firstDueDate: null, note: null, createdBy: "reception", today,
    })).ok).toBe(true);

    const visit = await addVisit({ patientName: "م", patientPhone: null, note: null, patientId, doctorId });
    await q(`UPDATE visits SET diagnosis = 'تسوّس 16' WHERE id = $1`, [visit.id]);
    await setVisitProcedures({ visitId: visit.id, procedures: [{
      serviceId: fillingId, toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 15000, priceReason: null, doctorId, note: null, planItemId: null,
    }] });
    const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, duesMinor: 15000 });

    /* قبل دفع القسط: المقترح ٣٠ ألفًا والمطلوب الآن ١٥ + ٣٠. */
    let walkout = await visitWalkout(visit.id);
    expect(walkout?.lines).toEqual([expect.objectContaining({ description: "حشوة", billingClass: "NEW_BILLABLE" })]);
    let [line] = await visitCheckoutSummary(walkout!);
    expect(line).toMatchObject({
      currency: "YER", previousBalanceMinor: 350_000, newBillableMinor: 15_000, currentBalanceMinor: 365_000,
      legacySuggestedMinor: 30_000, dueNowMinor: 45_000,
    });

    /* دفع قسط الرصيد السابق على opening_currency — بلا فاتورة جديدة. */
    const paid = await recordPayment({
      patientId, invoiceId: null, openingCurrency: "YER", kind: "payment", amountMinor: 30_000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();
    walkout = await visitWalkout(visit.id);
    [line] = await visitCheckoutSummary(walkout!);
    expect(line).toMatchObject({
      previousBalanceMinor: 350_000, newBillableMinor: 15_000, paymentsTodayMinor: 30_000, currentBalanceMinor: 335_000,
      todayRemainingMinor: 15_000, legacySuggestedMinor: 0, dueNowMinor: 15_000,
    });
    expect((await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).length).toBe(1);

    /* تأجيل الدفع بسببٍ مكتوب — قرارٌ في التدقيق لا حركة مالية. */
    expect(await deferVisitPayment(visit.id, { actor: "reception1", actorRole: "reception" }, "سيدفع الأسبوع القادم")).toMatchObject({ ok: true });
    const [audit] = await q<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE action = 'visit.payment_deferred' AND entity_id = $1`, [String(visit.id)]);
    expect(audit.details).toMatchObject({ السبب: "سيدفع الأسبوع القادم" });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, addVisit, recordAdjustment,
  recordPayment, setVisitProcedures, signClinicalVisit, getClinicalVisit, visitWalkout,
  patientLedger, patientPlanCurrencies, ledgerBalancesByCurrency,
} = db;
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctorId = 0;
let fillingId = 0;
let sequence = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  doctorId = (await q<{ id: number }>(
    `INSERT INTO parties (kind, name) VALUES ('doctor', 'د. التقويم') RETURNING id`))[0].id;
  fillingId = (await q<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured)
     VALUES ('حشوة 16', 'filling', 15000, TRUE) RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function legacyPatient(options: { mode: "opening_balance" | "prepaid_included"; opening?: boolean }) {
  sequence += 1;
  const name = `مريض تقويم سابق ${sequence}`;
  const patientId = (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
    [`LEG-ORTHO-${sequence}`, name]))[0].id;
  const caseId = (await q<{ id: number }>(
    `INSERT INTO ortho_cases
       (patient_id, created_by, baseline_kind, baseline_recorded_at, legacy_financial_mode,
        responsible_doctor_id, upper_wire, lower_wire)
     VALUES ($1, 'migration', 'legacy', NOW(), $2, $3, '016 NiTi', '016 NiTi') RETURNING id`,
    [patientId, options.mode, doctorId]))[0].id;
  if (options.opening) {
    await q(`INSERT INTO patient_opening_balances
      (patient_id, currency, amount_minor, as_of_date, created_by)
      VALUES ($1, 'YER', 350000, $2::date, 'migration')`, [patientId, today]);
  }
  const visit = await addVisit({ patientName: name, patientPhone: null, note: null, patientId, doctorId });
  return { patientId, caseId, visitId: visit.id };
}

async function adjustment(caseId: number) {
  const saved = await recordAdjustment({
    caseId, visitId: null, doneOn: today, phase: null, upperWire: "017×025 NiTi", lowerWire: null,
    elastics: "none", elasticNote: null, done: "شدّة دورية", nextWeeks: 4, note: null,
    recordedBy: "doctor", actorRole: "doctor",
  });
  if (!saved.ok) throw new Error(saved.message);
  return saved;
}

async function balance(patientId: number): Promise<number> {
  const ledger = await patientLedger(patientId);
  return ledgerBalancesByCurrency(patientId, ledger, await patientPlanCurrencies(patientId)).YER.dueMinor;
}

describe("P0-B legacy orthodontic billing guard", () => {
  it("keeps an unpaid opening 180000 through adjustment-only signing and repeated canonical reads", async () => {
    const { patientId, caseId, visitId } = await legacyPatient({ mode: "opening_balance" });
    await db.setPatientOpeningBalance({ patientId, currency: "YER", amountMinor: 180000, asOfDate: today,
      note: null, createdBy: "synthetic", reason: null });
    await adjustment(caseId);
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0, orthoBillingClass: "LEGACY_INCLUDED" });
    for (let read = 0; read < 2; read++) {
      const walkout = await visitWalkout(visitId);
      expect(walkout?.lines).toEqual([]);
      expect(walkout?.orthoAdjustment?.billingClass).toBe("LEGACY_INCLUDED");
      expect(walkout?.checkout.previous.YER).toBe(180000);
      expect(walkout?.checkout.current.YER).toBe(180000);
      expect(walkout?.balances).toContainEqual({ currency: "YER", balanceMinor: 180000 });
      expect((await db.patientWorkflow(patientId, today)).financial?.byCurrency.YER.balanceMinor).toBe(180000);
    }
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toEqual([]);
  });

  it("records the adjustment against an evidenced old receivable without a second invoice", async () => {
    const { patientId, caseId, visitId } = await legacyPatient({ mode: "opening_balance", opening: true });
    const paid = await recordPayment({
      patientId, invoiceId: null, openingCurrency: "YER", kind: "payment", amountMinor: 30000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();
    expect(await balance(patientId)).toBe(320000);

    const saved = await adjustment(caseId);
    expect(saved.visitId).toBe(visitId);
    expect((await getClinicalVisit(visitId))?.ortho?.adjustmentBillingClass).toBe("LEGACY_INCLUDED");
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0, orthoBillingClass: "LEGACY_INCLUDED" });
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toEqual([]);
    expect((await visitWalkout(visitId))?.orthoAdjustment).toMatchObject({ id: saved.id, billingClass: "LEGACY_INCLUDED" });
    expect(await balance(patientId)).toBe(320000);
    expect((await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor" })).reason).toBe("already_signed");
  });

  it("invoices only today's new filling while keeping the old adjustment included", async () => {
    const { patientId, caseId, visitId } = await legacyPatient({ mode: "opening_balance", opening: true });
    await recordPayment({
      patientId, invoiceId: null, openingCurrency: "YER", kind: "payment", amountMinor: 30000,
      currency: "YER", baseCurrency: "YER", exchangeRate: 1, method: "cash",
      note: null, createdBy: "cashier",
    });
    await adjustment(caseId);
    await setVisitProcedures({
      visitId,
      procedures: [{ serviceId: fillingId, toothCode: 16, surfaces: null, quantity: 1,
        unitPriceMinor: 15000, priceReason: null, doctorId, note: null, planItemId: null }],
    });
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, duesMinor: 15000, orthoBillingClass: "LEGACY_INCLUDED" });
    expect(signed.invoiceId).toEqual(expect.any(Number));
    expect(await q(`SELECT total_minor::int AS total_minor FROM invoices WHERE patient_id = $1`, [patientId]))
      .toEqual([{ total_minor: 15000 }]);
    expect(await q(`SELECT service_id, doctor_id, total_minor::int AS total_minor FROM invoice_items WHERE invoice_id = $1`, [signed.invoiceId]))
      .toEqual([{ service_id: fillingId, doctor_id: doctorId, total_minor: 15000 }]);
    expect((await visitWalkout(visitId))?.orthoAdjustment?.billingClass).toBe("LEGACY_INCLUDED");
    expect(await balance(patientId)).toBe(335000);
  });

  it("does not claim legacy coverage when its opening receivable is missing", async () => {
    const { caseId, visitId } = await legacyPatient({ mode: "opening_balance", opening: false });
    await adjustment(caseId);
    expect((await getClinicalVisit(visitId))?.ortho?.adjustmentBillingClass).toBe("OUTSIDE_CONTRACT");
    const signed = await signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed.orthoBillingClass).toBe("OUTSIDE_CONTRACT");
    expect(signed.invoiceId).toBeNull();
  });
});

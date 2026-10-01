import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, recordPayment,
  setPatientOpeningBalance, patientLedger, patientPlanCurrencies, ledgerBalancesByCurrency,
} = db;
const {
  createLegacyBalanceArrangement, listLegacyBalanceArrangements, cancelLegacyBalanceArrangement,
} = await import("../../lib/legacy-balance-arrangements-db");
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let seq = 0;
async function patient(name: string): Promise<number> {
  seq += 1;
  return (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`,
    [`LBA-${seq}`, name],
  ))[0].id;
}

async function count(table: string): Promise<number> {
  return Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0].n);
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);

afterAll(async () => { await resetPoolForTesting(); });

describe("P0-C legacy balance arrangements", () => {
  it("creates collection metadata only: no invoice/payment/debt is created", async () => {
    const patientId = await patient("تقويم قديم");
    await setPatientOpeningBalance({
      patientId, currency: "YER", amountMinor: 350_000, asOfDate: today,
      note: "متبقٍ قبل النظام", createdBy: "migration", reason: null,
    });
    const invoicesBefore = await count("invoices");
    const paymentsBefore = await count("payments");

    const created = await createLegacyBalanceArrangement({
      patientId, currency: "YER", cadence: "per_visit", installmentMinor: 30_000,
      firstDueDate: null, note: "30 ألف مع كل شدّة", createdBy: "reception", today,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.arrangement).toMatchObject({
      currency: "YER", startingDueMinor: 350_000, installmentMinor: 30_000,
      progress: { currentOpeningDueMinor: 350_000, suggestedMinor: 30_000 },
    });
    expect(await count("invoices")).toBe(invoicesBefore);
    expect(await count("payments")).toBe(paymentsBefore);

    const duplicate = await createLegacyBalanceArrangement({
      patientId, currency: "YER", cadence: "per_visit", installmentMinor: 20_000,
      firstDueDate: null, note: null, createdBy: "reception", today,
    });
    expect(duplicate).toMatchObject({ ok: false, reason: "already_active" });
  });

  it("a payment reduces the old opening receivable; a new invoice does not become part of the arrangement", async () => {
    const patientId = await patient("قديم مع عمل جديد");
    await setPatientOpeningBalance({
      patientId, currency: "YER", amountMinor: 350_000, asOfDate: today,
      note: null, createdBy: "migration", reason: null,
    });
    const created = await createLegacyBalanceArrangement({
      patientId, currency: "YER", cadence: "per_visit", installmentMinor: 30_000,
      firstDueDate: null, note: null, createdBy: "reception", today,
    });
    if (!created.ok) throw new Error("arrangement create failed");

    const paid = await recordPayment({
      patientId, invoiceId: null, openingCurrency: "YER", kind: "payment",
      amountMinor: 30_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: null, createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();

    await q(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
       VALUES ($1, $2, 15000, 0, 'YER', 'doctor')`,
      [`INV-LBA-${seq}`, patientId],
    );

    const [arrangement] = await listLegacyBalanceArrangements(patientId, today);
    expect(arrangement.progress).toMatchObject({
      currentOpeningDueMinor: 320_000,
      paidSinceStartMinor: 30_000,
      arrangementRemainingMinor: 320_000,
      suggestedMinor: 30_000,
    });

    const ledger = await patientLedger(patientId);
    const balances = ledgerBalancesByCurrency(patientId, ledger, await patientPlanCurrencies(patientId));
    expect(balances.YER.dueMinor).toBe(335_000);
    // The arrangement remains about the old 320k only; the 15k invoice is separate.
    expect(arrangement.progress.arrangementRemainingMinor).toBe(320_000);
  });

  it("keeps SAR and YER arrangements/payments in separate buckets", async () => {
    const patientId = await patient("رصيدان قديمان");
    await setPatientOpeningBalance({
      patientId, currency: "YER", amountMinor: 100_000, asOfDate: today,
      note: null, createdBy: "migration", reason: null,
    });
    await setPatientOpeningBalance({
      patientId, currency: "SAR", amountMinor: 50_000, asOfDate: today,
      note: null, createdBy: "migration", reason: null,
    });
    expect((await createLegacyBalanceArrangement({
      patientId, currency: "SAR", cadence: "per_visit", installmentMinor: 10_000,
      firstDueDate: null, note: null, createdBy: "reception", today,
    })).ok).toBe(true);

    await recordPayment({
      patientId, invoiceId: null, openingCurrency: "SAR", kind: "payment",
      amountMinor: 10_000, currency: "SAR", baseCurrency: "YER", exchangeRate: 140,
      method: "cash", note: null, createdBy: "cashier",
    });
    const [arrangement] = await listLegacyBalanceArrangements(patientId, today);
    expect(arrangement.currency).toBe("SAR");
    expect(arrangement.progress.currentOpeningDueMinor).toBe(40_000);

    const ledger = await patientLedger(patientId);
    const balances = ledgerBalancesByCurrency(patientId, ledger, await patientPlanCurrencies(patientId));
    expect(balances.SAR.dueMinor).toBe(40_000);
    expect(balances.YER.dueMinor).toBe(100_000);
  });

  it("cancels with history intact, then permits a replacement arrangement", async () => {
    const patientId = await patient("تغيير ترتيب");
    await setPatientOpeningBalance({
      patientId, currency: "YER", amountMinor: 90_000, asOfDate: today,
      note: null, createdBy: "migration", reason: null,
    });
    const first = await createLegacyBalanceArrangement({
      patientId, currency: "YER", cadence: "monthly", installmentMinor: 30_000,
      firstDueDate: today, note: null, createdBy: "reception", today,
    });
    if (!first.ok) throw new Error("first create failed");
    expect((await cancelLegacyBalanceArrangement({
      patientId, arrangementId: first.arrangement.id, actor: "admin", reason: "تغيير قيمة القسط",
    })).ok).toBe(true);
    const replacement = await createLegacyBalanceArrangement({
      patientId, currency: "YER", cadence: "per_visit", installmentMinor: 20_000,
      firstDueDate: null, note: null, createdBy: "admin", today,
    });
    expect(replacement.ok).toBe(true);
    expect(Number((await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM legacy_balance_arrangements WHERE patient_id = $1`, [patientId],
    ))[0].n)).toBe(2);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";
import {
  AR_ACCOUNT, BANK_ACCOUNT, CASH_ACCOUNT, CURRENCY_CLEARING_ACCOUNT,
  isBalanced, sideTotal,
} from "../../lib/accounting";
import { accountLedger, accountingPeriod } from "../../lib/accounting-reports";
import { clinicDateString } from "../../lib/schedule";
import type { Currency } from "../../lib/money";

const target = validatePostgresTestTarget(process.env);
stubPostgresEnv();
vi.mock("@/lib/session", () => ({
  requireSession: async () => ({ username: "ci-zero-base", role: "admin", userId: 1 }),
}));
const db = await import("../../lib/db");
const { GET: accounting } = await import("../../app/api/accounting/route");
const { GET: statement } = await import("../../app/api/patients/[id]/ledger/route");
const { GET: exportJournal } = await import("../../app/api/export/route");
const actor = "ci-zero-base";
let shiftId: number;
let sequence = 0;
const today = () => clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  const shift = await db.openShift({ openedBy: actor, opening: { YER: 0, SAR: 0, USD: 0 } });
  shiftId = shift!.id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture(currency: "SAR" | "USD", method: "cash" | "transfer", amountMinor: number, rate: number) {
  const key = `ci-zero-base-${++sequence}`;
  const { rows: [patient] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic zero-base receipt') RETURNING id", [key],
  );
  const { rows: [invoice] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,100,0,'YER') RETURNING id",
    [key, patient.id],
  );
  const input = {
    patientId: patient.id, invoiceId: invoice.id, kind: "payment" as const,
    amountMinor, currency, baseCurrency: "YER" as const, exchangeRate: rate, method,
    note: null, createdBy: actor, idempotencyKey: key,
  };
  const made = await db.recordPayment(input);
  expect(made.reason).toBeNull();
  expect(made.payment).not.toBeNull();
  return { input, original: made.payment! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function refund(f: Fixture, amountMinor: number, suffix: string) {
  const made = await db.recordPayment({
    ...f.input, kind: "refund", amountMinor, invoiceId: null,
    reversalOfId: f.original.id, idempotencyKey: `${f.input.idempotencyKey}-${suffix}`,
    exchangeRate: 999, // The original stored budget, never today's rate.
  });
  expect(made.reason).toBeNull();
  expect(made.payment).not.toBeNull();
  return made.payment!;
}
async function receiptRows(f: Fixture) {
  return (await db.getPool().query("SELECT * FROM payments WHERE patient_id=$1 ORDER BY id", [f.input.patientId])).rows;
}

async function assertReaders(f: Fixture, native: number, settled: number, count: number) {
  const before = await receiptRows(f);
  const ledger = await db.patientLedger(f.input.patientId);
  expect(ledger.payments).toHaveLength(count);
  expect(ledger.payments.reduce((sum, p) => sum + (p.kind === "refund" ? -p.amountMinor : p.amountMinor), 0)).toBe(native);
  expect(db.ledgerBalancesByCurrency(f.input.patientId, ledger, new Map()).YER).toMatchObject({
    billedMinor: 100, collectedMinor: settled, dueMinor: 100 - settled,
  });
  expect(await db.invoiceLinkedPaymentsByCurrency(f.input.invoiceId)).toEqual(
    native === 0 ? [] : [{ currency: f.input.currency, netMinor: native }],
  );
  const references = new Set(ledger.payments.map(p => p.receiptNumber));
  const allEntries = await db.journalEntries("0001-01-01", today());
  const entries = allEntries.filter(entry => references.has(entry.reference));
  expect(entries).toHaveLength(count);
  expect(entries.every(isBalanced)).toBe(true);
  for (const currency of ["YER", "SAR", "USD"] as const) {
    expect(entries.reduce((n, entry) => n + sideTotal(entry, "debit", currency), 0))
      .toBe(entries.reduce((n, entry) => n + sideTotal(entry, "credit", currency), 0));
  }
  const account = f.input.method === "cash" ? CASH_ACCOUNT[f.input.currency] : BANK_ACCOUNT[f.input.currency];
  const receiptReport = accountingPeriod(entries, "0001-01-01", today());
  expect(accountLedger(receiptReport, account, f.input.currency).closingBalanceMinor).toBe(native);
  expect(accountLedger(receiptReport, CURRENCY_CLEARING_ACCOUNT, f.input.currency).closingBalanceMinor).toBe(0 - native);
  expect(accountLedger(receiptReport, AR_ACCOUNT, "YER").closingBalanceMinor).toBe(0 - settled);
  expect(accountLedger(receiptReport, CURRENCY_CLEARING_ACCOUNT, "YER").closingBalanceMinor).toBe(settled);
  for (const payment of ledger.payments.filter(p => p.baseAmountMinor === 0)) {
    const entry = entries.find(e => e.reference === payment.receiptNumber)!;
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines.every(line => line.currency === f.input.currency && line.amountMinor === payment.amountMinor)).toBe(true);
    expect(entry.lines.some(line => line.accountCode === AR_ACCOUNT)).toBe(false);
  }
  // Cross-check aggregate journal readers against actual native receipt facts.
  // Do not make one test's cleanup a prerequisite for the next test's assertions.
  const { rows: [aggregate] } = await db.getPool().query<{ native: string; cash: string; transfer: string }>(`
    SELECT COALESCE(sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END),0)::text AS native,
      COALESCE(sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END) FILTER(WHERE method='cash'),0)::text AS cash,
      COALESCE(sum(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END) FILTER(WHERE method='transfer'),0)::text AS transfer
    FROM payments WHERE currency=$1`, [f.input.currency]);
  const aggregateNative = Number(aggregate.native);
  const shift = (await db.getShift(shiftId))!;
  expect(shift.expected[f.input.currency]).toBe(Number(aggregate.cash));
  const drawer = await db.shiftDrawerBreakdown(shift);
  expect(drawer.expected[f.input.currency]).toBe(shift.expected[f.input.currency]);
  expect((await db.financeSummary("0001-01-01", today())).income.byCurrency[f.input.currency]).toBe(aggregateNative);
  const fx = await db.fxReport(today());
  expect(fx.positions.find(p => p.currency === f.input.currency)).toMatchObject({
    cashMinor: aggregateNative, clearingMinor: 0 - aggregateNative,
  });

  const response = await accounting(new Request(`http://localhost/api/accounting?from=0001-01-01&to=${today()}&account=${account}&currency=${f.input.currency}`));
  expect(response.status).toBe(200);
  const accountBody = await response.json();
  expect(accountBody.closingBalanceMinor).toBe(Number(aggregate[f.input.method]));
  expect(accountBody.rows.filter((row: { reference: string }) => references.has(row.reference))).toHaveLength(count);
  const statementResponse = await statement(new Request(`http://localhost/api/patients/${f.input.patientId}/ledger`), {
    params: Promise.resolve({ id: String(f.input.patientId) }),
  });
  expect(statementResponse.status).toBe(200);
  const body = await statementResponse.json();
  expect(body.payments).toHaveLength(count);
  expect(body.balances.YER.collectedMinor).toBe(settled);
  expect(body.balances[f.input.currency].collectedMinor).toBe(0);
  const csv = await exportJournal(new Request(`http://localhost/api/export?table=journal&from=0001-01-01&to=${today()}`));
  expect(csv.status).toBe(200);
  const text = await csv.text();
  for (const reference of references) expect(text).toContain(reference);
  expect(await receiptRows(f)).toEqual(before); // Reading never rewrites stored evidence.
}

describe("real receipt writers and read-side zero-base accounting", () => {
  for (const currency of ["SAR", "USD"] as const satisfies readonly Currency[]) {
    for (const method of ["cash", "transfer"] as const) {
      it(`${currency} ${method}: cumulative [1,0,1] refunds conserve native cash and stored base`, async () => {
        const f = await fixture(currency, method, 3, 60);
        const original = (await receiptRows(f))[0];
        expect(f.original.baseAmountMinor).toBe(2);
        const first = await refund(f, 1, "first");
        const middle = await refund(f, 1, "middle");
        expect([first.baseAmountMinor, middle.baseAmountMinor]).toEqual([1, 0]);
        expect(Math.round(1 / 100 * f.original.exchangeRate)).toBe(1); // Old standalone rule could not create this zero.
        await db.saveSettings({ [`finance.rate.${currency}`]: "999" });
        await assertReaders(f, 1, 1, 3);
        const last = await refund(f, 1, "last");
        expect([first.baseAmountMinor, middle.baseAmountMinor, last.baseAmountMinor]).toEqual([1, 0, 1]);
        await assertReaders(f, 0, 0, 4);
        const rows = await receiptRows(f);
        expect(rows[0]).toEqual(original);
        expect(rows.slice(1).reduce((sum, row) => sum + Number(row.amount_minor), 0)).toBe(3);
        expect(rows.slice(1).reduce((sum, row) => sum + Number(row.base_amount_minor), 0)).toBe(2);
      });

      it(`${currency} ${method}: already-supported standalone zero-base payment/refund stays visible`, async () => {
        const f = await fixture(currency, method, 1, 1);
        expect(f.original.baseAmountMinor).toBe(0);
        await assertReaders(f, 1, 0, 1);
        const returned = await refund(f, 1, "full");
        expect(returned.baseAmountMinor).toBe(0);
        await assertReaders(f, 0, 0, 2);
      });
    }
  }
});

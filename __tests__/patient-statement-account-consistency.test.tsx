import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ledger: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "synthetic" }) }));
vi.mock("@/lib/db", async (original) => ({ ...await original<typeof import("../lib/db")>(),
  getPatient: async () => ({ id: 10, fullName: "Synthetic matrix patient", patientNumber: "SYN-MATRIX" }),
  patientLedger: mocks.ledger, getSettingsSafe: async () => ({}),
  patientPlanCurrencies: async () => new Map(), listPatientPlans: async () => [],
  // The current print reads the same sources in one snapshot; here it composes the same mocks.
  patientStatementSnapshot: async (id: number) => ({ ledger: await mocks.ledger(id), planCurrencies: new Map(), plans: [], historicalAgreements: [], statementEvidence: { invoiceCorrections: [], invoiceCancellations: [], paymentCorrections: [], openingHistory: [], allocationEffectiveAt: {} } }),
}));
vi.mock("@/components/PrintHeader", () => ({
  PrintHeader: () => createElement("h1", null, "Synthetic statement"), PrintFooter: () => null,
}));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));

import StatementPage from "../app/print/statement/[id]/page";
import { ledgerBalancesByCurrency, type Invoice, type Payment } from "../lib/db";
import { CURRENCIES, formatMoney, type Currency } from "../lib/money";
import { projectTreatmentFinancialReferences } from "../lib/treatment-financial-context";
import { historicalSnapshot } from "./treatment-financial-historical-fixture";

type Ledger = Parameters<typeof ledgerBalancesByCurrency>[1];
const date = "2026-09-03T10:00:00Z";
function invoice(id: number, currency: Currency, overrides: Partial<Invoice> = {}): Invoice {
  return { id, patientId: 10, patientName: "Synthetic matrix patient", invoiceNumber: `SYN-MATRIX-INV-${id}`,
    status: "open", totalMinor: 20000, discountMinor: 3000, baseCurrency: currency, note: null, createdAt: date,
    items: [{ id, serviceId: 900, doctorId: null, description: `علاج السن ٢٦ — SYN-LINE-${id}`,
      quantity: 2, unitPriceMinor: 10000, totalMinor: 20000 }], ...overrides };
}
function payment(id: number, currency: Currency, overrides: Partial<Payment> = {}): Payment {
  return { id, patientId: 10, patientName: "Synthetic matrix patient", receiptNumber: `SYN-MATRIX-REC-${id}`,
    invoiceId: 1, planId: null, openingCurrency: null, shiftId: 1, kind: "payment", reversalOfId: null,
    currency, amountMinor: 5000, baseAmountMinor: currency === "YER" ? 5000 : 700000,
    baseCurrency: "YER", exchangeRate: currency === "YER" ? 1 : 140,
    method: "cash", note: null, createdBy: "synthetic", createdAt: date, ...overrides };
}
function fixture(currency: Currency, discountMinor: number) {
  const otherCurrency: Currency = currency === "USD" ? "SAR" : "USD";
  const ledger: Ledger = {
    invoices: [invoice(1, currency, { status: "cancelled" }), invoice(2, currency, { discountMinor }),
      invoice(3, otherCurrency, { totalMinor: 9000, discountMinor: 0,
        items: [{ ...invoice(3, otherCurrency).items[0], quantity: 1, unitPriceMinor: 9000, totalMinor: 9000 }] })],
    payments: [payment(1, currency), payment(2, currency, { kind: "refund", reversalOfId: 1,
      amountMinor: 1000, baseAmountMinor: currency === "YER" ? 1000 : 140000 }),
    payment(3, currency, { kind: "refund", invoiceId: null, amountMinor: 500,
      baseAmountMinor: currency === "YER" ? 500 : 70000 })],
    openings: [{ patientId: 10, patientName: "Synthetic matrix patient", phone: null, currency: "YER",
      amountMinor: 450000, asOfDate: "2026-09-01", note: null, createdBy: "synthetic", updatedAt: date }],
  };
  // Shape adaptation only: all billing and settlement calculations remain production readers.
  const snapshot = historicalSnapshot();
  snapshot.invoices = ledger.invoices.map((row) => ({ id: row.id, patientId: row.patientId,
    planId: null, invoiceNumber: row.invoiceNumber, currency: row.baseCurrency,
    totalMinor: row.totalMinor, discountMinor: row.discountMinor, status: row.status }));
  snapshot.receipts = ledger.payments.map((row) => ({ ...row, reversalOfId: row.reversalOfId ?? null }));
  return { ledger, snapshot, otherCurrency };
}
function summaryValues(html: string, label: string): string[] {
  return [...html.matchAll(new RegExp(`<span>${label}</span><span class="num">([^<]+)</span>`, "g"))]
    .map((match) => match[1]);
}
beforeEach(() => vi.clearAllMocks());

describe("statement and treatment-account cross-reader acceptance (synthetic, no database)", () => {
  it.each(CURRENCIES.flatMap((currency) => [
    { currency, discountMinor: 3000, billedMinor: 17000, dueWithoutOpening: 13500 },
    { currency, discountMinor: 20000, billedMinor: 0, dueWithoutOpening: -3500 },
  ]))("reconciles $currency discount $discountMinor without losing cancelled-document receipts", async ({ currency, discountMinor, billedMinor, dueWithoutOpening }) => {
    const { ledger, snapshot, otherCurrency } = fixture(currency, discountMinor);
    const before = structuredClone({ ledger, snapshot });
    const account = projectTreatmentFinancialReferences(snapshot);
    const balances = ledgerBalancesByCurrency(10, ledger, new Map());
    expect(account.accountPositions).toEqual(balances);
    expect(balances[currency]).toMatchObject({ billedMinor, collectedMinor: 3500,
      openingMinor: currency === "YER" ? 450000 : 0,
      dueMinor: dueWithoutOpening + (currency === "YER" ? 450000 : 0) });
    expect(balances[otherCurrency]).toMatchObject({ billedMinor: 9000, collectedMinor: 0, dueMinor: 9000 });
    expect(balances.YER.openingMinor).toBe(450000);

    mocks.ledger.mockResolvedValue(ledger);
    // Headless server-function invocation, not a claim of Next/browser E2E coverage.
    const html = renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: "10" }) }));
    const displayedCurrencies = CURRENCIES.filter((key) => key === "YER" || key === currency || key === otherCurrency);
    expect(summaryValues(html, "إجمالي المفوتر")).toEqual(displayedCurrencies.map((key) => formatMoney(balances[key].billedMinor, key)));
    expect(summaryValues(html, "صافي المدفوع"))
      .toEqual(displayedCurrencies.map((key) => formatMoney(balances[key].collectedMinor, key)));
    expect(summaryValues(html, "الرصيد الحالي")).toEqual(displayedCurrencies.map((key) => {
      const due = balances[key].dueMinor;
      return due === 0 ? "المستحق الحالي مسدّد" : `${due > 0 ? "على المريض" : "للمريض"} ${formatMoney(Math.abs(due), key)}`;
    }));
    expect(html).not.toContain("SYN-MATRIX-INV-1");
    expect(html).not.toContain("SYN-LINE-1");
    expect(html.match(/data-invoice-id="2"/g)).toHaveLength(1);
    expect(html).toContain("علاج السن ٢٦ — SYN-LINE-2");
    expect(html).toContain(`الخصم المسجل</td><td class="num">${formatMoney(discountMinor, currency)}`);
    for (const receipt of ledger.payments) expect(html).toContain(receipt.receiptNumber);
    expect(html).not.toContain("عكس سند");
    expect(html).toContain("استرداد");
    // Clinical references retain cancelled document provenance; patient print hides its charge/details.
    expect(account.documents.find((row) => row.invoiceId === 1)).toMatchObject({ status: "cancelled", netMinor: 0,
      directlyLinkedSettledMinor: 4000 });
    expect(account.historicalDocuments[0]).toMatchObject({ agreedMinor: 540000, remainingAtRevisionMinor: 450000 });
    expect({ ledger, snapshot }).toEqual(before);

    // A valid historical display-only revision changes explanation, never live billing or receipts.
    const revised = structuredClone(snapshot);
    const revision = revised.historicalDocuments![0].revision!;
    revision.totalMinor += 20000;
    revision.remainingMinor += 20000;
    const lines = revision.lines as { unitPriceMinor: number; netMinor: number }[];
    lines[0].unitPriceMinor += 20000;
    lines[0].netMinor += 20000;
    const revisedAccount = projectTreatmentFinancialReferences(revised);
    expect(revisedAccount.historicalDocuments[0].remainingAtRevisionMinor).toBe(470000);
    expect(revisedAccount.accountPositions).toEqual(account.accountPositions);
  });

  it("settles foreign cash against a YER original without moving its replacement charge to the cash currency", async () => {
    const { ledger, snapshot } = fixture("YER", 3000);
    const cash = payment(1, "SAR"); // 5,000 SAR minor, stored equivalent 700,000 YER minor.
    const fxLedger: Ledger = { ...ledger, payments: [cash] };
    snapshot.receipts = [{ ...cash, reversalOfId: cash.reversalOfId ?? null }];
    const account = projectTreatmentFinancialReferences(snapshot);
    const balances = ledgerBalancesByCurrency(10, fxLedger, new Map());
    expect(account.accountPositions).toEqual(balances);
    expect(balances.YER).toMatchObject({ billedMinor: 17000, collectedMinor: 700000, dueMinor: -233000 });
    expect(balances.SAR).toMatchObject({ billedMinor: 0, collectedMinor: 0, dueMinor: 0 });
    mocks.ledger.mockResolvedValue(fxLedger);
    const html = renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: "10" }) }));
    expect(html).toContain(formatMoney(5000, "SAR"));
    expect(html).toContain(`للمريض ${formatMoney(233000, "YER")}`);
    expect(html).not.toContain("SYN-MATRIX-INV-1");
  });
});

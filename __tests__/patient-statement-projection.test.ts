import { describe, expect, it, vi } from "vitest";
import { ledgerBalancesByCurrency, type Invoice, type OpeningBalance, type Payment } from "../lib/db";
import { emptyStatementEvidence, projectPatientStatement, StatementProjectionError, type StatementProjectionInput } from "../lib/patient-statement-projection";
import { portalStatementView } from "../lib/portal-statement";
import type { Currency } from "../lib/money";

const day = (value: string) => `${value}T10:00:00Z`;
function invoice(id: number, date = "2026-01-01", overrides: Partial<Invoice> = {}): Invoice {
  return { id, patientId: 17, patientName: "اصطناعي", invoiceNumber: `SYN-I-${id}`, baseCurrency: "YER", status: "open", totalMinor: 1000, discountMinor: 0,
    createdAt: day(date), note: "INTERNAL-INVOICE", items: [{ id, serviceId: 33, doctorId: 45, description: "حشوة", quantity: 1, unitPriceMinor: 1000, totalMinor: 1000, toothCode: 26, surfaces: "MO" }], ...overrides };
}
function payment(id: number, amountMinor: number, date = "2026-01-02", overrides: Partial<Payment> = {}): Payment {
  return { id, patientId: 17, patientName: "اصطناعي", receiptNumber: `SYN-R-${id}`, invoiceId: 1, planId: null, openingCurrency: null,
    shiftId: 53, kind: "payment", reversalOfId: null, amountMinor, currency: "YER", baseAmountMinor: amountMinor, baseCurrency: "YER", exchangeRate: 1,
    method: "cash", note: "INTERNAL-RECEIPT", createdBy: "INTERNAL-USERNAME", createdAt: day(date), ...overrides };
}
function input(invoices: Invoice[] = [invoice(1)], payments: Payment[] = []): StatementProjectionInput {
  return { patientId: 17, ledger: { invoices, payments, openings: [] }, planCurrencies: new Map(), evidence: emptyStatementEvidence() };
}
function parity(source: StatementProjectionInput) {
  expect(projectPatientStatement(source).balances).toEqual(ledgerBalancesByCurrency(17, source.ledger, new Map(source.planCurrencies)));
}
function correct(source: StatementProjectionInput, originalId: number, reversalId: number, replacementId: number | null, date: string) {
  source.evidence.paymentCorrections.push({ originalId, reversalId, replacementId, createdAt: day(date) });
}

describe("patient copy: persisted correction evidence and canonical bucket parity", () => {
  it("hides an internally voided receipt and its reversal, but retains an actual cash refund with the SAME reversalOfId shape", () => {
    const source = input(undefined, [payment(1, 100), payment(2, 100, "2026-02-01", { kind: "refund", reversalOfId: 1 }), payment(3, 300), payment(4, 30, "2026-02-02", { kind: "refund", reversalOfId: 3 })]);
    correct(source, 1, 2, null, "2026-02-01");
    const result = projectPatientStatement(source);
    expect(result.payments.map(p => p.receiptNumber)).toEqual(["SYN-R-3", "SYN-R-4"]);
    expect(result.payments[1]).toMatchObject({ kind: "refund", label: "استرداد", amountMinor: 30 });
    parity(source);
  });
  it("uses neither Arabic correction notes nor broad refund suppression to classify a payment", () => {
    const source = input(undefined, [payment(1, 100, "2026-01-02", { note: "بدل السند" }), payment(2, 25, "2026-01-03", { kind: "refund", reversalOfId: 1, note: "تصحيح السند" })]);
    expect(projectPatientStatement(source).payments).toHaveLength(2);
    parity(source);
  });
  it("compresses repeated corrections, retaining only the final effective receipt", () => {
    const source = input(undefined, [payment(1, 100), payment(2, 100, "2026-02-01", { kind: "refund", reversalOfId: 1 }), payment(3, 150, "2026-02-01"),
      payment(4, 150, "2026-03-01", { kind: "refund", reversalOfId: 3 }), payment(5, 125, "2026-03-01")]);
    correct(source, 1, 2, 3, "2026-02-01"); correct(source, 3, 4, 5, "2026-03-01");
    expect(projectPatientStatement(source).payments).toEqual([expect.objectContaining({ receiptNumber: "SYN-R-5", amountMinor: 125 })]);
    expect(projectPatientStatement(source, { to: "2026-01-31" }).payments[0].receiptNumber).toBe("SYN-R-1");
    expect(projectPatientStatement(source, { to: "2026-02-28" }).payments[0].receiptNumber).toBe("SYN-R-3");
    parity(source);
  });
  it("retains real partial refund before correction and subtracts exact stored base amounts, never a proportional guess", () => {
    const source = input(undefined, [payment(1, 3, "2026-01-02", { currency: "SAR", baseAmountMinor: 10 }),
      payment(2, 1, "2026-01-03", { currency: "SAR", baseAmountMinor: 3, kind: "refund", reversalOfId: 1 }),
      payment(3, 2, "2026-02-01", { currency: "SAR", baseAmountMinor: 7, kind: "refund", reversalOfId: 1 }),
      payment(4, 20, "2026-02-01")]);
    correct(source, 1, 3, 4, "2026-02-01");
    const result = projectPatientStatement(source);
    expect(result.payments[0]).toMatchObject({ amountMinor: 1, baseAmountMinor: 3, settlementMinor: 3, settlementCurrency: "YER" });
    expect(result.payments[1]).toMatchObject({ kind: "refund", amountMinor: 1 });
    expect(result.balances.YER.collectedMinor).toBe(20);
    parity(source);
  });
  it.each<Currency>(["YER", "SAR", "USD"])("preserves exact %s totals, discounts and no plan-principal double-counting", (currency) => {
    const source = input([invoice(1, undefined, { baseCurrency: currency, totalMinor: 900, discountMinor: 100 })], [payment(1, 350, undefined, { currency }), payment(2, 50, "2026-02-01", { currency, kind: "refund", reversalOfId: 1 })]);
    source.planCurrencies = new Map([[9, { patientId: 17, currency }]]);
    const result = projectPatientStatement(source);
    expect(result.balances[currency]).toEqual({ billedMinor: 800, collectedMinor: 300, openingMinor: 0, dueMinor: 500 });
    parity(source);
  });
  it("retains former invoice and receipt settlement before a later cross-currency correction", () => {
    const source = input([invoice(1, "2026-01-01", { status: "cancelled" }), invoice(2, "2026-03-01", { baseCurrency: "SAR", totalMinor: 100 })],
      [payment(1, 50, "2026-01-02", { currency: "SAR", baseAmountMinor: 500, settlementAllocation: { paymentId: 1, sourceInvoiceId: 1, targetInvoiceId: 2, sourceCurrency: "YER", targetCurrency: "SAR", sourceMinor: 500, targetMinor: 50, documentId: 12 } })]);
    source.evidence.invoiceCorrections.push({ originalInvoiceId: 1, correctedInvoiceId: 2, createdAt: day("2026-03-01") });
    source.evidence.allocationEffectiveAt[1] = day("2026-03-01");
    const historical = projectPatientStatement(source, { to: "2026-02-28" });
    expect(historical.invoices.map(i => i.invoiceNumber)).toEqual(["SYN-I-1"]);
    expect(historical.balances.YER).toMatchObject({ billedMinor: 1000, collectedMinor: 500, dueMinor: 500 });
    expect(historical.balances.SAR.dueMinor).toBe(0);
    expect(projectPatientStatement(source).balances.SAR.dueMinor).toBe(50);
    parity(source);
  });
  it("current and as-of invoice replacements follow stored edges across repeated corrections", () => {
    const source = input([invoice(1, "2026-01-01", { status: "cancelled" }), invoice(2, "2026-02-01", { status: "cancelled", totalMinor: 800 }), invoice(3, "2026-03-01", { totalMinor: 600 })]);
    source.evidence.invoiceCorrections.push({ originalInvoiceId: 1, correctedInvoiceId: 2, createdAt: day("2026-02-01") }, { originalInvoiceId: 2, correctedInvoiceId: 3, createdAt: day("2026-03-01") });
    expect(projectPatientStatement(source, { to: "2026-01-31" }).invoices[0].netMinor).toBe(1000);
    expect(projectPatientStatement(source, { to: "2026-02-28" }).invoices[0].netMinor).toBe(800);
    expect(projectPatientStatement(source).invoices[0].netMinor).toBe(600);
    parity(source);
  });
  it("uses correction event dates for copied-date replacements and repeated corrections", () => {
    const source = input([invoice(1, "2026-01-01", { status: "cancelled" }), invoice(2, "2026-01-01", { status: "cancelled", totalMinor: 800 }), invoice(3, "2026-01-01", { totalMinor: 600 })]);
    source.evidence.invoiceCorrections.push({ originalInvoiceId: 1, correctedInvoiceId: 2, createdAt: day("2026-02-01") },
      { originalInvoiceId: 2, correctedInvoiceId: 3, createdAt: day("2026-03-01") });
    expect(projectPatientStatement(source, { to: "2026-01-31" }).invoices.map(i => i.invoiceNumber)).toEqual(["SYN-I-1"]);
    expect(projectPatientStatement(source, { to: "2026-02-28" }).invoices.map(i => i.invoiceNumber)).toEqual(["SYN-I-2"]);
    const current = projectPatientStatement(source);
    expect(current.invoices).toEqual([expect.objectContaining({ invoiceNumber: "SYN-I-3", createdAt: day("2026-01-01"), netMinor: 600 })]);
    const period = projectPatientStatement(source, { from: "2026-02-01", to: "2026-03-31" }).period!;
    expect(period.opening.YER).toBe(1000); expect(period.closing.YER).toBe(600);
    expect(period.movements).toEqual([
      expect.objectContaining({ date: "2026-02-01", creditMinor: 200, balanceMinor: 800 }),
      expect.objectContaining({ date: "2026-03-01", creditMinor: 200, balanceMinor: 600 }),
    ]);
    parity(source);
    source.evidence.invoiceCorrections[1].createdAt = day("2026-01-15");
    expect(() => projectPatientStatement(source)).toThrow(StatementProjectionError);
  });
  it("period opening plus dated net movements equals closing even when an older invoice/receipt changes later", () => {
    const source = input([invoice(1, "2026-01-01", { status: "cancelled" }), invoice(2, "2026-03-01", { totalMinor: 800 })],
      [payment(1, 300), payment(2, 300, "2026-03-02", { kind: "refund", reversalOfId: 1 }), payment(3, 400, "2026-03-02")]);
    source.evidence.invoiceCorrections.push({ originalInvoiceId: 1, correctedInvoiceId: 2, createdAt: day("2026-03-01") });
    correct(source, 1, 2, 3, "2026-03-02");
    const result = projectPatientStatement(source, { from: "2026-03-01", to: "2026-03-31" });
    expect(result.period?.opening.YER).toBe(700);
    expect(result.period?.closing.YER).toBe(400);
    expect(result.period?.movements.map(m => m.creditMinor)).toEqual([200, 100]);
    const serialized = JSON.stringify(result.period);
    expect(serialized).not.toMatch(/SYN-I-1|SYN-R-1|تصحيح|عكس|إبطال|ملغ/);
  });
  it("period movements retain a real cash refund even when equal cash received on the same day nets to zero", () => {
    const source = input([invoice(1)], [payment(1, 100, "2026-03-01"), payment(2, 100, "2026-03-01", { kind: "refund", reversalOfId: 1 })]);
    const result = projectPatientStatement(source, { from: "2026-03-01", to: "2026-03-31" });
    expect(result.period?.opening.YER).toBe(1000);
    expect(result.period?.closing.YER).toBe(1000);
    expect(result.period?.movements).toEqual([
      expect.objectContaining({ description: "صافي المدفوعات", creditMinor: 100, balanceMinor: 900 }),
      expect.objectContaining({ description: "استرداد — SYN-R-2", debitMinor: 100, balanceMinor: 1000 }),
    ]);
  });
  it("opening history reproduces the earlier recorded balance instead of applying today's amended opening", () => {
    const source = input([], []);
    source.ledger.openings = [{ patientId: 17, patientName: "synthetic", phone: null, currency: "USD", amountMinor: 700, asOfDate: "2025-01-01", updatedAt: day("2026-04-01"), note: null, createdBy: "internal" } satisfies OpeningBalance];
    source.evidence.openingHistory.push({ id: 1, currency: "USD", beforeAmountMinor: null, beforeAsOfDate: null, afterAmountMinor: 1000, afterAsOfDate: "2025-01-01", createdAt: day("2025-01-01") },
      { id: 2, currency: "USD", beforeAmountMinor: 1000, beforeAsOfDate: "2025-01-01", afterAmountMinor: 700, afterAsOfDate: "2025-01-01", createdAt: day("2026-04-01") });
    expect(projectPatientStatement(source, { to: "2026-03-31" }).balances.USD.openingMinor).toBe(1000);
    const period = projectPatientStatement(source, { from: "2026-04-01", to: "2026-04-30" }).period!;
    expect(period.opening.USD).toBe(1000); expect(period.closing.USD).toBe(700);
    expect(period.movements[0]).toMatchObject({ creditMinor: 300, balanceMinor: 700 });
    parity(source);
  });
  it("retains a legacy opening's effective date when later history moved it outside the requested period", () => {
    const source = input([], []);
    source.ledger.openings = [{ patientId: 17, patientName: "synthetic", phone: null, currency: "YER", amountMinor: 100,
      asOfDate: "2026-04-01", updatedAt: day("2026-04-02"), note: null, createdBy: "synthetic" }];
    source.evidence.openingHistory.push({ id: 1, currency: "YER", beforeAmountMinor: 100, beforeAsOfDate: "2026-03-01",
      afterAmountMinor: 100, afterAsOfDate: "2026-04-01", createdAt: day("2026-04-02") });
    const period = projectPatientStatement(source, { from: "2026-03-01", to: "2026-03-31" }).period!;
    expect(period.opening.YER).toBe(0);
    expect(period.closing.YER).toBe(100);
    expect(period.movements).toEqual([expect.objectContaining({ date: "2026-03-01", debitMinor: 100, balanceMinor: 100 })]);
  });
  it("respects clinic midnight rather than slicing UTC receipt dates", () => {
    const source = input([], [payment(1, 100, undefined, { invoiceId: null, createdAt: "2026-02-28T22:30:00Z" })]);
    expect(projectPatientStatement(source, { to: "2026-02-28" }).payments).toHaveLength(0);
    expect(projectPatientStatement(source, { to: "2026-03-01" }).payments).toHaveLength(1);
  });
  it("uses the same safe rows and canonical totals in the portal without leaking audit, linkage, actor or note fields", () => {
    const source = input(undefined, [payment(1, 100)]);
    const projected = projectPatientStatement(source);
    const portal = portalStatementView(source.ledger, projected.balances, "YER", [], [], projected);
    expect(portal.invoices[0]).toMatchObject({ invoiceNumber: projected.invoices[0].invoiceNumber, netMinor: projected.invoices[0].netMinor });
    expect(portal.payments[0]).toMatchObject({ receiptNumber: projected.payments[0].receiptNumber, amountMinor: projected.payments[0].amountMinor });
    expect(portal.balances).toEqual(projected.balances);
    const text = JSON.stringify(portal);
    expect(text).not.toMatch(/INTERNAL|createdBy|patientId|serviceId|doctorId|reversalOfId|documentId|shiftId|invoiceId|method|note/);
    expect(projected.invoices[0].items[0]).toMatchObject({ toothCode: 26, surfaces: "MO" });
  });
  it("refuses corrupted owner/edge evidence and historical cancellation without a dated record", () => {
    const crossOwner = input(undefined, [payment(1, 100, undefined, { patientId: 18 })]);
    expect(() => projectPatientStatement(crossOwner)).toThrow(StatementProjectionError);
    const missing = input([invoice(1, undefined, { status: "cancelled" })]);
    expect(projectPatientStatement(missing).invoices).toHaveLength(0);
    expect(() => projectPatientStatement(missing, { to: "2026-03-31" })).toThrow(StatementProjectionError);
    const bad = input(undefined, [payment(1, 100), payment(2, 100, "2026-02-01", { kind: "refund", reversalOfId: 1, currency: "USD" })]);
    correct(bad, 1, 2, null, "2026-02-01");
    expect(() => projectPatientStatement(bad)).toThrow(StatementProjectionError);
  });
});


describe("configured clinic-day projection", () => {
  it("honors the configured zone instead of always applying the default clinic offset", async () => {
    vi.stubEnv("CLINIC_TIME_ZONE", "UTC");
    vi.resetModules();
    try {
      const { projectPatientStatement: project } = await import("../lib/patient-statement-projection");
      const source = input([], [payment(1, 100, undefined, { invoiceId: null, createdAt: "2026-02-28T22:30:00Z" })]);
      expect(project(source, { to: "2026-02-28" }).payments).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });
  it("keeps date-only opening entries on their recorded day even at UTC+14", async () => {
    vi.stubEnv("CLINIC_TIME_ZONE", "Pacific/Kiritimati");
    vi.resetModules();
    try {
      const { projectPatientStatement: project } = await import("../lib/patient-statement-projection");
      const source = input([], []);
      source.ledger.openings = [{ patientId: 17, patientName: "synthetic", phone: null, currency: "YER", amountMinor: 100,
        asOfDate: "2026-03-01", updatedAt: "2026-02-28T12:00:00Z", note: null, createdBy: "synthetic" }];
      const period = project(source, { from: "2026-03-01", to: "2026-03-01" }).period!;
      expect(period.opening.YER).toBe(0);
      expect(period.closing.YER).toBe(100);
      expect(period.movements).toEqual([expect.objectContaining({ date: "2026-03-01", debitMinor: 100, balanceMinor: 100 })]);
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });
});

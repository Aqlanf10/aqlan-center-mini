import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIN-INT-8: the patient portal statement and the printed statement are the same
 * statement. A cancelled invoice is not listed, the invoice amount is its net after
 * the recorded discount, reversals carry the same label, the current invoices carry the
 * printed treatment lines, active agreements carry the printed total/paid/remaining, and
 * nothing internal (staff usernames, notes, shifts, methods, row, service, doctor or
 * lineage ids, cancelled lines) reaches the patient.
 * Synthetic presentation evidence only: no live patient data or database writes.
 */

const mocks = vi.hoisted(() => ({ portal: vi.fn(), staff: vi.fn(), getPatient: vi.fn(), patientLedger: vi.fn(),
  getSettingsSafe: vi.fn(), patientPlanCurrencies: vi.fn(), listPatientPlans: vi.fn() }));
vi.mock("@/lib/portal-server", () => ({ requirePortalSession: mocks.portal }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.staff }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/db")>(),
  getPatient: mocks.getPatient, patientLedger: mocks.patientLedger, getSettingsSafe: mocks.getSettingsSafe,
  patientPlanCurrencies: mocks.patientPlanCurrencies, listPatientPlans: mocks.listPatientPlans,
  // The portal reads the same three sources in one snapshot; here it composes the same mocks.
  patientStatementSnapshot: async (patientId: number, today: string) => ({ ledger: await mocks.patientLedger(patientId),
    planCurrencies: await mocks.patientPlanCurrencies(patientId), plans: await mocks.listPatientPlans(patientId, today), historicalAgreements: [] }) }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => createElement("h1", null, title), PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));

import { GET } from "../app/api/portal/statement/route";
import StatementPage from "../app/print/statement/[id]/page";
import type { Invoice, OpeningBalance, Payment, TreatmentPlan } from "../lib/db";
import { ledgerBalancesByCurrency } from "../lib/db";
import { formatMoney } from "../lib/money";
import { portalStatementView } from "../lib/portal-statement";
import { historicalOpeningBuckets, type HistoricalStatementAgreement } from "../lib/statement-historical-details";
import { statementPaymentLabel as printLabel } from "../app/print/statement/[id]/presentation";

const INTERNAL = ["STAFF-USERNAME-SECRET", "INTERNAL-RECEIPT-NOTE", "INTERNAL-INVOICE-NOTE", "INTERNAL-OPENING-NOTE",
  "CANCELLED-OLD-TREATMENT", "SYN-CANCELLED-ORIGINAL", "+967-700-000-000", "SUM-OF-ITEMS-PLAN", "COMPLETED-AGREEMENT"];

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return { id: 2, invoiceNumber: "SYN-CORRECTED-2", patientId: 17, patientName: "Synthetic patient",
    status: "open", totalMinor: 14000, discountMinor: 3000, baseCurrency: "SAR", note: "INTERNAL-INVOICE-NOTE",
    createdAt: "2026-09-03T10:00:00Z", items: [{ id: 2, serviceId: 900, doctorId: 4, description: "LINE-ITEM-DETAIL",
      quantity: 2, unitPriceMinor: 7000, totalMinor: 14000, originInvoiceId: 1 }], ...overrides };
}
function payment(overrides: Partial<Payment> = {}): Payment {
  return { id: 1, receiptNumber: "SYN-REC-1", patientId: 17, patientName: "Synthetic patient",
    invoiceId: 1, planId: null, openingCurrency: null, shiftId: 91, kind: "payment", reversalOfId: null,
    amountMinor: 5000, currency: "SAR", exchangeRate: 140, baseAmountMinor: 700000, baseCurrency: "YER",
    method: "cash", note: "INTERNAL-RECEIPT-NOTE", createdBy: "STAFF-USERNAME-SECRET",
    createdAt: "2026-09-02T10:00:00Z", ...overrides };
}
function ledger() {
  const original = invoice({ id: 1, invoiceNumber: "SYN-CANCELLED-ORIGINAL", status: "cancelled", totalMinor: 20000,
    items: [{ ...invoice().items[0], id: 1, description: "CANCELLED-OLD-TREATMENT", originInvoiceId: null }] });
  const paid = invoice({ id: 3, invoiceNumber: "SYN-PAID-3", status: "paid", totalMinor: 9000, discountMinor: 0,
    baseCurrency: "YER", note: null, items: [] });
  const opening: OpeningBalance = { patientId: 17, patientName: "Synthetic patient", phone: "+967-700-000-000",
    currency: "YER", amountMinor: 2500, asOfDate: "2026-01-01", note: "INTERNAL-OPENING-NOTE",
    createdBy: "STAFF-USERNAME-SECRET", updatedAt: "2026-01-01T00:00:00Z" };
  return { invoices: [original, invoice(), paid],
    payments: [payment(), payment({ id: 2, receiptNumber: "SYN-REC-2", invoiceId: 3, currency: "YER", amountMinor: 9000,
      exchangeRate: 1, baseAmountMinor: 9000 }),
    payment({ id: 4, receiptNumber: "SYN-REV-4", kind: "refund", reversalOfId: 1, amountMinor: 5000 }),
    payment({ id: 5, receiptNumber: "SYN-REF-5", invoiceId: 3, kind: "refund", currency: "YER", amountMinor: 1000,
      exchangeRate: 1, baseAmountMinor: 1000 })],
    openings: [opening] };
}

/** Synthetic plans: one active agreement, one item-summed plan and one completed agreement. */
function plans() {
  const progress = (totalMinor: number, paidMinor: number) => ({ totalMinor, dueToDateMinor: totalMinor, paidMinor,
    remainingMinor: totalMinor - paidMinor, overdueMinor: 0, nextDueDate: null, nextDueAmountMinor: 0, paidCount: 0 });
  return [
    { id: 41, title: "SYN-ORTHO-AGREEMENT", status: "active", totalFromItems: false, totalMinor: 300000, baseCurrency: "SAR", progress: progress(300000, 120000) },
    { id: 42, title: "SUM-OF-ITEMS-PLAN", status: "active", totalFromItems: true, totalMinor: 50000, baseCurrency: "YER", progress: progress(50000, 0) },
    { id: 43, title: "COMPLETED-AGREEMENT", status: "completed", totalFromItems: false, totalMinor: 90000, baseCurrency: "USD", progress: progress(90000, 90000) },
  ] as unknown as TreatmentPlan[];
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.portal.mockResolvedValue({ patientId: 17 });
  mocks.staff.mockResolvedValue({ role: "admin", username: "synthetic", userId: 1 });
  mocks.getSettingsSafe.mockResolvedValue({});
  mocks.getPatient.mockResolvedValue({ id: 17, fullName: "Synthetic patient", patientNumber: "SYN-17" });
  mocks.patientPlanCurrencies.mockResolvedValue(new Map());
  mocks.listPatientPlans.mockResolvedValue([]);
});

describe("portal statement is the printed statement, without internal data", () => {
  it("lists only current invoices at their net amount, with the print's paid/open state", async () => {
    const source = ledger();
    const before = structuredClone(source);
    mocks.patientLedger.mockResolvedValue(source);
    const response = await GET();
    expect(response.status).toBe(200);
    const feed = await response.json();
    expect(feed.invoices).toEqual([
      { invoiceNumber: "SYN-CORRECTED-2", createdAt: "2026-09-03T10:00:00Z", totalMinor: 14000, discountMinor: 3000,
        netMinor: 11000, status: "open", baseCurrency: "SAR",
        items: [{ description: "LINE-ITEM-DETAIL", quantity: 2, unitPriceMinor: 7000, totalMinor: 14000 }] },
      { invoiceNumber: "SYN-PAID-3", createdAt: "2026-09-03T10:00:00Z", totalMinor: 9000, discountMinor: 0,
        netMinor: 9000, status: "paid", baseCurrency: "YER", items: [] },
    ]);
    expect(source).toEqual(before);
  });

  it("keeps every receipt with the print's label and the canonical balances unchanged", async () => {
    const source = ledger();
    mocks.patientLedger.mockResolvedValue(source);
    const feed = await (await GET()).json();
    expect(feed.payments.map((row: { receiptNumber: string; label: string }) => [row.receiptNumber, row.label])).toEqual(
      source.payments.map((row) => [row.receiptNumber, printLabel(row, source.payments)]));
    expect(feed.payments.map((row: { label: string }) => row.label)).toEqual(["دفعة", "دفعة", "عكس سند SYN-REC-1", "استرداد"]);
    expect(feed.balances).toEqual(JSON.parse(JSON.stringify(ledgerBalancesByCurrency(17, source, new Map()))));
    expect(feed.openings).toEqual([{ currency: "YER", amountMinor: 2500, asOfDate: "2026-01-01" }]);
    expect(feed.baseCurrency).toBe("YER");
  });

  it("sends nothing internal: exact keys, no staff names, notes, shifts, methods, ids or cancelled lines", async () => {
    mocks.patientLedger.mockResolvedValue(ledger());
    mocks.listPatientPlans.mockResolvedValue(plans());
    const body = await (await GET()).text();
    for (const secret of INTERNAL) expect(body).not.toContain(secret);
    const feed = JSON.parse(body);
    expect(Object.keys(feed).sort()).toEqual(["agreements", "balances", "baseCurrency", "historical", "invoices", "openings", "payments"]);
    for (const row of feed.invoices) expect(Object.keys(row).sort()).toEqual(
      ["baseCurrency", "createdAt", "discountMinor", "invoiceNumber", "items", "netMinor", "status", "totalMinor"]);
    // Treatment lines carry only what the print shows: no line, service, doctor or lineage ids.
    for (const line of feed.invoices.flatMap((row: { items: object[] }) => row.items)) expect(Object.keys(line).sort()).toEqual(
      ["description", "quantity", "totalMinor", "unitPriceMinor"]);
    for (const row of feed.agreements) expect(Object.keys(row).sort()).toEqual(
      ["currency", "paidMinor", "remainingMinor", "title", "totalMinor"]);
    for (const row of feed.payments) expect(Object.keys(row).sort()).toEqual(
      ["amountMinor", "createdAt", "currency", "kind", "label", "receiptNumber"]);
  });

  it("prints the same current documents, nets and balances the portal returns", async () => {
    const source = ledger();
    mocks.patientLedger.mockResolvedValue(source);
    const feed = await (await GET()).json();
    const html = renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: "17" }) }));
    expect(html).not.toContain("SYN-CANCELLED-ORIGINAL");
    for (const row of feed.invoices) {
      expect(html).toContain(row.invoiceNumber);
      expect(html).toContain(formatMoney(row.netMinor, row.baseCurrency));
    }
    for (const row of feed.payments) expect(html).toContain(row.label === "دفعة" ? row.receiptNumber : row.label);
    expect(html).toContain(formatMoney(feed.balances.SAR.dueMinor, "SAR"));
  });

  it("shows each current invoice's printed treatment lines at the stored prices, never a cancelled line", async () => {
    const source = ledger();
    mocks.patientLedger.mockResolvedValue(source);
    const feed = await (await GET()).json();
    const html = renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: "17" }) }));
    const printed = source.invoices.filter((row) => row.status !== "cancelled");
    expect(feed.invoices.map((row: { invoiceNumber: string }) => row.invoiceNumber)).toEqual(printed.map((row) => row.invoiceNumber));
    feed.invoices.forEach((row: { items: { description: string; quantity: number; unitPriceMinor: number; totalMinor: number }[]; baseCurrency: "YER" | "SAR" | "USD" }, index: number) => {
      expect(row.items).toEqual(printed[index].items.map(({ description, quantity, unitPriceMinor, totalMinor }) => ({ description, quantity, unitPriceMinor, totalMinor })));
      for (const line of row.items) {
        expect(html).toContain(line.description);
        expect(html).toContain(formatMoney(line.unitPriceMinor, row.baseCurrency));
        expect(html).toContain(formatMoney(line.totalMinor, row.baseCurrency));
      }
    });
    expect(html).not.toContain("CANCELLED-OLD-TREATMENT");
  });

  it("shows the printed agreements only: active, agreed totals, in their own currency, from the canonical progress", async () => {
    mocks.patientLedger.mockResolvedValue(ledger());
    mocks.listPatientPlans.mockResolvedValue(plans());
    const feed = await (await GET()).json();
    expect(mocks.listPatientPlans).toHaveBeenCalledWith(17, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(feed.agreements).toEqual([
      { title: "SYN-ORTHO-AGREEMENT", currency: "SAR", totalMinor: 300000, paidMinor: 120000, remainingMinor: 180000 },
    ]);
    const html = renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: "17" }) }));
    for (const row of feed.agreements) {
      expect(html).toContain(row.title);
      for (const amount of [row.totalMinor, row.paidMinor, row.remainingMinor]) expect(html).toContain(formatMoney(amount, row.currency));
    }
    expect(html).not.toContain("SUM-OF-ITEMS-PLAN");
    expect(html).not.toContain("COMPLETED-AGREEMENT");
  });

  it("an unauthenticated portal request is refused in Arabic and reads nothing", async () => {
    mocks.portal.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect((await response.json()).message).toMatch(/[؀-ۿ]/);
    expect(mocks.patientLedger).not.toHaveBeenCalled();
    expect(mocks.listPatientPlans).not.toHaveBeenCalled();
  });

  it("a ledger read failure is a generic Arabic 500 without exception detail", async () => {
    mocks.patientLedger.mockRejectedValue(new Error("SECRET-STACK-DETAIL"));
    const response = await GET();
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("SECRET-STACK-DETAIL");
    expect(JSON.parse(body).message).toMatch(/[؀-ۿ]/);
  });

  it("the projection itself never mutates its input", () => {
    const source = ledger();
    const before = structuredClone(source);
    const balances = ledgerBalancesByCurrency(17, source, new Map());
    const agreements = plans();
    const plansBefore = structuredClone(agreements);
    portalStatementView(source, balances, "YER", agreements, []);
    expect(agreements).toEqual(plansBefore);
    expect(source).toEqual(before);
  });
});

it.each([true, false])("keeps current amended agreement tuple identical in portal and print when available=%s", async available => {
  const source = ledger();mocks.patientLedger.mockResolvedValue(source);
  const p = { ...plans()[0], totalMinor: 500000, baseCurrency: "YER" as const,
    progress: { ...plans()[0].progress, totalMinor: 800000, paidMinor: 180000, remainingMinor: 620000 },
    approvedAgreement: { planId: 41, currency: "YER" as const, totalMinor: 800000, paidMinor: 180000, remainingMinor: 620000, dueNowMinor: 620000, invoiceId: 5, openingCurrency: null, sourceKind: "invoice" as const, available, originalTotalMinor: 500000, deltaInvoiceIds: [6] } };
  mocks.listPatientPlans.mockResolvedValue([p]);
  const feed = await (await GET()).json();
  const html = renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: "17" }) }));
  if (available) {
    expect(feed.agreements).toEqual([{ title: p.title, currency: "YER", totalMinor: 800000, paidMinor: 180000, remainingMinor: 620000 }]);
    expect(html).toContain(formatMoney(800000, "YER"));expect(html).toContain(formatMoney(620000, "YER"));
    expect(html).not.toContain(formatMoney(500000, "YER"));
  } else { expect(feed.agreements).toEqual([]);expect(feed.agreementsRequireReview).toBe(true);expect(html).toContain("غير متاحة وتحتاج مراجعة مصدرها");expect(html).not.toContain(formatMoney(620000, "YER")); }
  expect(html).not.toContain(formatMoney(320000, "YER"));
  // Cross-feature composition: #463 historical allowlisting and #469 current approved balance must
  // coexist. A bad historical section cannot erase valid current debt; unavailable current debt
  // cannot invent a classic balance or suppress valid historical facts. Neither changes the ledger.
  const historical: HistoricalStatementAgreement = {
    kind: "document", id: 94941, version: 7, currency: "YER", historicalAsOf: "2025-01-01",
    lines: [{ description: "SYN-HISTORICAL-LINE", site: "36", quantity: 1, unitPriceMinor: 4000, discountMinor: 0, netMinor: 4000 }],
    grossMinor: 4000, discountMinor: 0, agreedMinor: 4000, previouslyPaidMinor: 1500, remainingMinor: 2500,
  };
  const balances = ledgerBalancesByCurrency(17, source, new Map());
  const before = structuredClone({ source, p, historical, balances });
  for (const buckets of [historicalOpeningBuckets([historical], source.openings, source.payments), null]) {
    const combined = portalStatementView(source, balances, "YER", [p], buckets);
    expect(combined.agreements).toEqual(feed.agreements);
    expect(combined.agreementsRequireReview).toBe(available ? undefined : true);
    expect(combined.balances).toEqual(balances);
    expect(combined.invoices).toEqual(feed.invoices);
    expect(combined.payments).toEqual(feed.payments);
    if (buckets === null) expect(combined.historical).toEqual({ available: false });
    else {
      expect(combined.historical).toEqual({ available: true, agreements: [{ historicalAsOf: "2025-01-01", currency: "YER", lines: historical.lines,
        grossMinor: 4000, discountMinor: 0, agreedMinor: 4000, previouslyPaidMinor: 1500, remainingMinor: 2500 }], undetailed: [] });
      expect(JSON.stringify(combined.historical)).not.toMatch(/94941|"version"|"kind"|"id"/);
    }
  }
  expect({ source, p, historical, balances }).toEqual(before);
});

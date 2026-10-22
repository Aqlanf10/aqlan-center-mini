import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FIN-INT-8: the patient portal statement and the printed statement are the same
 * statement. A cancelled invoice is not listed, the invoice amount is its net after
 * the recorded discount, reversals carry the same label, and nothing internal (staff
 * usernames, notes, shifts, methods, row ids, line items) reaches the patient.
 * Synthetic presentation evidence only: no live patient data or database writes.
 */

const mocks = vi.hoisted(() => ({ portal: vi.fn(), staff: vi.fn(), getPatient: vi.fn(), patientLedger: vi.fn(),
  getSettingsSafe: vi.fn(), patientPlanCurrencies: vi.fn(), listPatientPlans: vi.fn() }));
vi.mock("@/lib/portal-server", () => ({ requirePortalSession: mocks.portal }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.staff }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/db")>(),
  getPatient: mocks.getPatient, patientLedger: mocks.patientLedger, getSettingsSafe: mocks.getSettingsSafe,
  patientPlanCurrencies: mocks.patientPlanCurrencies, listPatientPlans: mocks.listPatientPlans }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => createElement("h1", null, title), PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));

import { GET } from "../app/api/portal/statement/route";
import StatementPage from "../app/print/statement/[id]/page";
import type { Invoice, OpeningBalance, Payment } from "../lib/db";
import { ledgerBalancesByCurrency } from "../lib/db";
import { formatMoney } from "../lib/money";
import { portalStatementView } from "../lib/portal-statement";
import { statementPaymentLabel as printLabel } from "../app/print/statement/[id]/presentation";

const INTERNAL = ["STAFF-USERNAME-SECRET", "INTERNAL-RECEIPT-NOTE", "INTERNAL-INVOICE-NOTE", "INTERNAL-OPENING-NOTE",
  "CANCELLED-OLD-TREATMENT", "SYN-CANCELLED-ORIGINAL", "LINE-ITEM-DETAIL", "+967-700-000-000"];

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
        netMinor: 11000, status: "open", baseCurrency: "SAR" },
      { invoiceNumber: "SYN-PAID-3", createdAt: "2026-09-03T10:00:00Z", totalMinor: 9000, discountMinor: 0,
        netMinor: 9000, status: "paid", baseCurrency: "YER" },
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

  it("sends nothing internal: exact keys, no staff names, notes, shifts, methods, ids or line items", async () => {
    mocks.patientLedger.mockResolvedValue(ledger());
    const body = await (await GET()).text();
    for (const secret of INTERNAL) expect(body).not.toContain(secret);
    const feed = JSON.parse(body);
    expect(Object.keys(feed).sort()).toEqual(["balances", "baseCurrency", "invoices", "openings", "payments"]);
    for (const row of feed.invoices) expect(Object.keys(row).sort()).toEqual(
      ["baseCurrency", "createdAt", "discountMinor", "invoiceNumber", "netMinor", "status", "totalMinor"]);
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

  it("an unauthenticated portal request is refused in Arabic and reads nothing", async () => {
    mocks.portal.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect((await response.json()).message).toMatch(/[؀-ۿ]/);
    expect(mocks.patientLedger).not.toHaveBeenCalled();
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
    portalStatementView(source, balances, "YER");
    expect(source).toEqual(before);
  });
});

import { describe, expect, it } from "vitest";
import { restrictedRouteAllowed } from "../lib/role-routes";
import { parseInvoiceArchiveCommand, invoiceArchiveEligibility } from "../lib/invoice-archive";

const input = { action: "archive", reason: "Synthetic archive reason", idempotencyKey: "synthetic-archive-command", expectedVersion: 0 };
describe("invoice archive admission contract", () => {
  it("admits only explicit versioned documentary transitions", () => {
    expect(parseInvoiceArchiveCommand(input)).toEqual(input);
    expect(parseInvoiceArchiveCommand({ ...input, action: "restore", reason: "  Synthetic restore reason  " })).toMatchObject({ action: "restore", reason: "Synthetic restore reason" });
  });
  it.each([null, [], {}, { ...input, action: "cancelled" }, { ...input, status: "paid" }, { ...input, reason: "x" }, { ...input, reason: "x".repeat(301) }, { ...input, idempotencyKey: "short" }, { ...input, expectedVersion: -1 }, { ...input, expectedVersion: 0.5 }])("refuses unsupported/ambiguous command %j", value => {
    expect(() => parseInvoiceArchiveCommand(value)).toThrow();
  });
  it.each(["open", "paid"] as const)("never treats recorded %s status as proof that unpaid debt can be archived", status => {
    expect(invoiceArchiveEligibility(status, 7000)).toMatchObject({ canArchive: false, code: "policy_decision_required", remainingMinor: 7000 });
    expect(invoiceArchiveEligibility(status, null)).toMatchObject({ canArchive: false, code: "policy_decision_required" });
  });
  it("admits proven settled current invoices, preserving status separately", () => {
    expect(invoiceArchiveEligibility("open", 0)).toMatchObject({ canArchive: true, code: null });
    expect(invoiceArchiveEligibility("paid", 0)).toMatchObject({ canArchive: true, code: null });
  });
  it("does not silently assume an unverified cancelled document is settled", () => {
    expect(invoiceArchiveEligibility("cancelled", null)).toMatchObject({ canArchive: false, code: "policy_decision_required" });
  });
});

it.each(["cashier", "accountant"])("keeps %s archive settlement reads behind existing patient-ledger access", role => {
  for (const path of ["/api/invoices/archive", "/api/invoices/42/archive", "/api/invoices/42/archive/"]) {
    expect(restrictedRouteAllowed(role, path, "GET", { viewPatientLedger: false })).toBe(false);
    expect(restrictedRouteAllowed(role, path, "GET", { viewPatientLedger: true })).toBe(true);
    expect(restrictedRouteAllowed(role, path, "POST", { viewPatientLedger: true })).toBe(false);
  }
});

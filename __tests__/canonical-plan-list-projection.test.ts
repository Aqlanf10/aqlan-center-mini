/** M2 slice 94a (G4-1, G4-6): the plan list field matrix (contract section 9). Every grant
 * combination; each hidden group omitted, never nulled or zeroed; no hidden sentinel in the JSON. */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { projectCanonicalPlan } = await import("../lib/canonical-plan-list");

const PRICE = 811111, ITEM_PRICE = 822222, PAID = 833333, REMAIN = 844444, INSTALMENT = 855555, NOTE = "SYN-CLINICAL-NOTE", TOOTH_NOTE = "SYN-ITEM-NOTE";
const plan = {
  id: 7, patientId: 3, patientName: "SYN", patientPhone: "SYN-PHONE", title: "SYN clinical title", totalMinor: PRICE, baseCurrency: "YER", status: "active",
  startDate: "2026-11-01", note: NOTE, createdAt: "2026-11-01T08:00:00Z", lastReminderAt: "2026-11-02T08:00:00Z",
  installments: [{ id: 1, number: 1, dueDate: "2026-12-01", amountMinor: INSTALMENT, lastReminderAt: "2026-11-02T08:00:00Z" }],
  paidMinor: PAID, progress: { totalMinor: PRICE, dueToDateMinor: 0, paidMinor: PAID, remainingMinor: REMAIN, overdueMinor: 0, nextDueDate: null, nextDueAmountMinor: 0, paidCount: 0, count: 1 },
  items: [{ id: 9, serviceId: 2, serviceName: "SYN crown", category: "crown", toothCode: 11, surfaces: null, quantity: 1, unitPriceMinor: ITEM_PRICE, totalMinor: ITEM_PRICE,
    status: "planned", visitId: null, doneAt: null, note: TOOTH_NOTE, plannedVisitNumber: 1, billingRule: "per_procedure", billingStatus: "unbilled", sessionCount: 1,
    sessionsCompleted: 0, doctorId: 4, doctorName: "SYN DR", billedInvoiceId: 55 }],
  itemsProgress: { count: 1, doneCount: 0, totalMinor: ITEM_PRICE, doneMinor: 0, remainingMinor: ITEM_PRICE },
  totalFromItems: true, consentAt: null, consentBy: null, consentNote: null, agreementApproved: true, debtSource: "invoice", invoiceFinancial: { kind: "invoice_backed", paidMinor: PAID },
} as never;

describe("plan list projection", () => {
  for (const clinical of [false, true]) for (const prices of [false, true]) for (const account of [false, true]) {
    it(`clinical=${clinical} prices=${prices} account=${account}`, () => {
      const body = projectCanonicalPlan(plan, { clinical, prices, account }) as Record<string, unknown>;
      const json = JSON.stringify(body);
      expect(body).toMatchObject({ id: 7, patientId: 3, status: "active", baseCurrency: "YER" });
      expect(body.title).toBe(clinical ? "SYN clinical title" : "خطة مالية #7");
      expect("items" in body).toBe(clinical);
      expect(json.includes(NOTE) || json.includes(TOOTH_NOTE)).toBe(clinical);
      // The agreement total is an invoice detail and a ledger total (G4-1; the slice 88 account read).
      expect("totalMinor" in body).toBe(prices || account);
      expect(json.includes(String(PRICE))).toBe(prices || account);
      expect(json.includes(String(ITEM_PRICE))).toBe(clinical && prices);
      expect(json.includes(String(INSTALMENT))).toBe(prices);
      expect(json.includes("billedInvoiceId")).toBe(clinical && prices);
      expect("paidMinor" in body).toBe(account);
      expect(json.includes(String(PAID))).toBe(account);
      expect(json.includes(String(REMAIN))).toBe(account);
      expect("invoiceFinancial" in body).toBe(account);
      // The plan picker's structure for every reader (legacy withoutPlanPayments): ids only without prices.
      expect(body).toMatchObject({ agreementApproved: true, hasInstallments: true });
      expect(body.installments).toEqual(prices ? [expect.objectContaining({ id: 1, amountMinor: INSTALMENT })] : [{ id: 1 }]);
      expect(json.includes("2026-12-01")).toBe(prices);
      if (clinical) expect((body.itemsProgress as Record<string, unknown>).totalMinor === undefined).toBe(!prices);
      // Hidden groups are omitted, never nulled.
      for (const value of Object.values(body)) expect(value).not.toBeUndefined();
      if (!account) expect(body).not.toHaveProperty("progress");
    });
  }

  it("an allowlist: an unknown field on the source never reaches the body", () => {
    const tainted = { ...(plan as object), secretCostMinor: 999999, progress: { ...(plan as { progress: object }).progress, hiddenMinor: 999999 }, items: [{ ...(plan as { items: object[] }).items[0], costMinor: 999999 }] } as never;
    expect(JSON.stringify(projectCanonicalPlan(tainted, { clinical: true, prices: true, account: true }))).not.toContain("999999");
  });
});

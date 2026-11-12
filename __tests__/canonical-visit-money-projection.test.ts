/** M2 slice 89: the walkout field matrix (contract section 6). Every grant combination;
 * each hidden group omitted (never zeroed); derived fields only with every input grant; the
 * collect action only with finance.payments.collect; no hidden sentinel in the serialized body. */
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const { projectCanonicalWalkout } = await import("../lib/canonical-visit-money");

// Distinct sentinels per group, so any leak is visible in the JSON.
const PAY = 711111, LEDGER = 722222, REMAIN = 733333, DUE = 744444, REC = 755555;
const walkout = {
  visitId: 9, patientId: 3, patientName: "SYN", patientNumber: "P-1", arrivedAt: "2026-11-05T08:00:00.000Z", signedAt: null,
  doctorName: "SYN DR", treatmentDone: "SYN done", nextPlan: "SYN next",
  lines: [{ description: "SYN crown", toothCode: 11, quantity: 1, unitPriceMinor: 50000, currency: "YER", included: false, billingClass: "NEW_BILLABLE", financialReviewRequired: false }],
  orthoAdjustment: null, invoice: { id: 4, number: "INV-4", netMinor: 50000, currency: "YER" },
  payments: [{ receiptNumber: "R-1", kind: "payment", amountMinor: PAY, currency: "YER" }],
  balances: [{ currency: "YER", balanceMinor: LEDGER }],
  nextAppointment: { date: "2026-12-01", time: "10:00" }, deferred: false,
  checkout: { previous: { YER: LEDGER }, current: { YER: LEDGER }, invoicePaidMinor: PAY, paymentsToday: [{ currency: "YER", netMinor: PAY }], openingPaidToday: [{ currency: "YER", netMinor: PAY }] },
} as never;
const summary = [{ currency: "YER", previousBalanceMinor: LEDGER, newBillableMinor: 50000, paymentsTodayMinor: PAY, currentBalanceMinor: LEDGER,
  todayRemainingMinor: REMAIN, legacySuggestedMinor: LEDGER, legacyRemainingMinor: LEDGER, dueNowMinor: DUE }] as never;
const dueRecommendation = { patientId: 3, visitInvoiceId: 4, accountHref: "/patients/3", collectionAction: "visit_invoice",
  currencies: [{ currency: "YER", currentBalanceMinor: REC, knownRemainingMinor: REC, otherRemainingMinor: 0, dueNowMinor: REC, status: "verified", reasons: [],
    sources: [{ kind: "visit_invoice", authorityId: 4, currency: "YER", invoiceId: 4, openingCurrency: null, remainingMinor: REC, dueNowMinor: REC, available: true }] }] } as never;
const project = (grants: { payments: boolean; ledger: boolean; collect: boolean; handoff: boolean }) =>
  projectCanonicalWalkout({ walkout, summary, dueRecommendation, signedToday: false, receptionHandoff: { status: "pending", handledReason: null } }, grants);

describe("walkout projection", () => {
  for (const payments of [false, true]) for (const ledger of [false, true]) for (const collect of [false, true]) {
    it(`payments=${payments} ledger=${ledger} collect=${collect}`, () => {
      const body = project({ payments, ledger, collect, handoff: false });
      const json = JSON.stringify(body);
      // Dues (admission) always: the invoice and the line prices.
      expect(body.invoice).toEqual({ id: 4, number: "INV-4", netMinor: 50000, currency: "YER" });
      expect(body.lines[0]).toMatchObject({ unitPriceMinor: 50000, billingClass: "NEW_BILLABLE" });
      expect(body.summary[0]).toMatchObject({ newBillableMinor: 50000 });
      // Payments.
      expect("payments" in body).toBe(payments);
      expect("invoicePaidMinor" in body.checkout).toBe(payments);
      expect("todayRemainingMinor" in body.summary[0]).toBe(payments);
      expect(json.includes(String(PAY))).toBe(payments);
      expect(json.includes(String(REMAIN))).toBe(payments);
      // Account (ledger).
      expect("balances" in body).toBe(ledger);
      expect("previous" in body.checkout).toBe(ledger);
      expect(json.includes(String(LEDGER))).toBe(ledger);
      // Derived dues: invoices AND payments AND ledger.
      const due = payments && ledger;
      expect("dueNowMinor" in body.summary[0]).toBe(due);
      expect("dueRecommendation" in body).toBe(due);
      expect(json.includes(String(DUE))).toBe(due);
      expect(json.includes(String(REC))).toBe(due);
      // The collect action only with its grant; a read grant never offers it.
      if (due) expect((body as { dueRecommendation: { collectionAction: string } }).dueRecommendation.collectionAction).toBe(collect ? "visit_invoice" : "none");
      // Hidden groups are omitted, never zeroed.
      if (!payments) expect(body.summary[0]).not.toHaveProperty("paymentsTodayMinor");
      if (!ledger) expect(body.summary[0]).not.toHaveProperty("currentBalanceMinor");
    });
  }

  it("the reception handoff only with visits.manage", () => {
    expect(project({ payments: true, ledger: true, collect: true, handoff: false })).not.toHaveProperty("receptionHandoff");
    expect(project({ payments: false, ledger: false, collect: false, handoff: true })).toMatchObject({ receptionHandoff: { status: "pending" } });
  });

  it("an allowlist: an unknown field on the source never reaches the body", () => {
    const tainted = { ...(walkout as object), secretCostMinor: 999999, lines: [{ ...(walkout as { lines: object[] }).lines[0], costMinor: 999999 }] } as never;
    const body = projectCanonicalWalkout({ walkout: tainted, summary, dueRecommendation, signedToday: false }, { payments: true, ledger: true, collect: true, handoff: true });
    expect(JSON.stringify(body)).not.toContain("999999");
  });
});

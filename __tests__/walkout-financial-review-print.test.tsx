import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VisitWalkout } from "../lib/db";
import { formatMoney } from "../lib/money";
import WalkoutPage from "../app/print/walkout/[id]/page";

const state = vi.hoisted(() => ({ walkout: null as VisitWalkout | null }));
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "UTC", getSettingsSafe: async () => ({}),
  getVisitOwner: async () => ({ patientId: 1 }), visitWalkout: async () => state.walkout,
}));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ username: "synthetic", role: "reception" }) }));
vi.mock("../lib/operational-access", () => ({ authorizeVisit: async () => ({ ok: true }) }));
vi.mock("../lib/walkout-access", () => ({ canSeeWalkout: async () => true }));
vi.mock("../components/PrintHeader", () => ({ PrintHeader: () => null, PrintFooter: () => null }));
vi.mock("../components/PrintButton", () => ({ PrintButton: () => null }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("unexpected missing fixture"); } }));

beforeEach(() => {
  state.walkout = {
    visitId: 10, patientId: 1, patientName: "مريض صناعي", patientNumber: "SYN-1",
    arrivedAt: "2026-10-07T08:00:00Z", signedAt: "2026-10-07T09:00:00Z", doctorName: "طبيب صناعي",
    treatmentDone: "عمل موثق سابقًا", nextPlan: null,
    lines: [{ description: "حشوة", toothCode: 26, quantity: 1, unitPriceMinor: 987654,
      currency: "YER", included: false, billingClass: "NO_CHARGE", financialReviewRequired: true }],
    orthoAdjustment: null, invoice: null, payments: [],
    balances: [{ currency: "YER", balanceMinor: 432100 }], nextAppointment: null, deferred: false,
    checkout: { previous: {}, current: { YER: 432100 }, invoicePaidMinor: 0, paymentsToday: [], openingPaidToday: [] },
  };
});
const render = async () => renderToStaticMarkup(await WalkoutPage({ params: Promise.resolve({ id: "10" }) }));

describe("printed walkout uses canonical financial-review evidence", () => {
  it.each(["INCLUDED", "LEGACY_INCLUDED"] as const)("prints adjustment-only %s without invented work or an invoice", async (billingClass) => {
    state.walkout!.lines = [];
    state.walkout!.orthoAdjustment = { id: 30, billingClass, decision: null, pendingDecision: false };
    state.walkout!.balances = [{ currency: "YER", balanceMinor: 180000 }];
    const html = await render();
    expect(html).toContain("شدّة تقويم");
    expect(html).toContain(billingClass === "INCLUDED" ? "مشمول بالاتفاق" : "مشمول بالعلاج السابق");
    expect(html).not.toContain("كشف ومتابعة");
    expect(html).toContain(formatMoney(180000, "YER"));
    expect(state.walkout!.invoice).toBeNull();
  });
  it("does not print a pending outside-contract adjustment as free", async () => {
    state.walkout!.lines = [];
    state.walkout!.orthoAdjustment = { id: 30, billingClass: "OUTSIDE_CONTRACT", decision: null, pendingDecision: true };
    const html = await render();
    expect(html).toContain("خارج العقد — قرار فوترة معلّق");
    expect(html).not.toContain("لا رسوم على هذه الزيارة");
    expect(html).not.toContain("كشف ومتابعة");
  });

  it("never prints unresolved work as free/included/collectible while retaining known account balances", async () => {
    const html = await render();
    expect(html).toContain("يحتاج مراجعة مالية — التغطية غير محسومة");
    expect(html).toContain("لا فاتورة جديدة للزيارة؛ توجد بنود تحتاج مراجعة مالية");
    expect(html).not.toContain("لا رسوم على هذه الزيارة");
    expect(html).not.toContain("مشمول بالخطة");
    expect(html).not.toContain(formatMoney(987654, "YER"));
    expect(html).toContain(formatMoney(432100, "YER"));
  });
  it("does not hide an independently established invoice or payment because a work line needs review", async () => {
    state.walkout!.invoice = { id: 20, number: "INV-KNOWN", netMinor: 225500, currency: "YER" };
    state.walkout!.payments = [{ receiptNumber: "RCPT-KNOWN", kind: "payment", amountMinor: 100000, currency: "YER" }];
    const html = await render();
    expect(html).toContain("INV-KNOWN");
    expect(html).toContain("RCPT-KNOWN");
    expect(html).toContain(formatMoney(225500, "YER"));
    expect(html).toContain(formatMoney(100000, "YER"));
    expect(html).toContain("التغطية غير محسومة");
  });
  it("preserves the existing verified included rendering when review is not required", async () => {
    state.walkout!.lines[0] = { ...state.walkout!.lines[0], financialReviewRequired: false, included: true, billingClass: "INCLUDED" };
    const html = await render();
    expect(html).toContain("مشمول بالاتفاق");
    expect(html).not.toContain("التغطية غير محسومة");
  });
});

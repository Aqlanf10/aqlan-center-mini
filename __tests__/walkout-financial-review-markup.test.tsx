import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WalkoutLine } from "../lib/db";
import { isCheckoutWalkout, WalkoutLineBilling } from "../components/patient/CheckoutExtras";

vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));

const line = (billingClass: WalkoutLine["billingClass"], review: boolean): WalkoutLine => ({
  description: "عمل موثق", toothCode: 26, quantity: 1, unitPriceMinor: 1500000, currency: "YER",
  included: billingClass === "INCLUDED", billingClass, financialReviewRequired: review,
});
const render = (value: WalkoutLine) => renderToStaticMarkup(createElement(WalkoutLineBilling, { line: value }));

describe("walkout financial-review presentation precedence", () => {
  it("does not infer free work from a positive-price line without an established invoice", () => {
    const html = render(line("NO_CHARGE", false));
    expect(html).toContain("يحتاج مراجعة مالية");
    expect(html).not.toContain("بلا رسوم");
    expect(html).not.toContain("1,500,000");
  });

  it.each(["INCLUDED", "NO_CHARGE", "NEW_BILLABLE"] as const)("does not present unresolved %s as covered, free, or collectible", (classification) => {
    const html = render(line(classification, true));
    expect(html).toContain("يحتاج مراجعة مالية");
    expect(html).toContain("التغطية غير محسومة");
    expect(html).not.toContain("مشمول بالاتفاق");
    expect(html).not.toContain("بلا رسوم");
    expect(html).not.toContain("مستحق جديد");
    expect(html).not.toContain("1,500,000");
  });
  it("preserves ordinary server-classified presentation when no review is required", () => {
    expect(render(line("INCLUDED", false))).toContain("مشمول بالاتفاق");
    expect(render({ ...line("NO_CHARGE", false), unitPriceMinor: 0 })).toContain("بلا رسوم");
    expect(render(line("NEW_BILLABLE", false))).toContain("مستحق جديد");
  });
});

it("rejects malformed or incomplete walkout financial evidence before publishing a label or collection control", () => {
  const read = { visitId: 10, patientId: 1, patientName: "Synthetic", deferred: false,
    lines: [line("NO_CHARGE", true)], orthoAdjustment: null, nextAppointment: null, summary: [] };
  expect(isCheckoutWalkout(read, 10)).toBe(true);
  for (const lines of [[null], [{ ...read.lines[0], billingClass: "unknown" }],
    [{ ...read.lines[0], financialReviewRequired: undefined }], [{ ...read.lines[0], financialReviewRequired: "false" }]]) {
    expect(isCheckoutWalkout({ ...read, lines }, 10)).toBe(false);
  }
  expect(isCheckoutWalkout({ ...read, summary: [{}] }, 10)).toBe(false);
  expect(isCheckoutWalkout(read, 11)).toBe(false);
});

it("rejects coerced reception lifecycle states and unverified signature metadata", () => {
  const read = { visitId: 10, patientId: 1, patientName: "Synthetic", deferred: false,
    lines: [], orthoAdjustment: null, nextAppointment: null, summary: [], signedAt: "2026-10-10T09:00:00.000Z",
    receptionHandoff: { status: "pending", handledReason: null } };
  expect(isCheckoutWalkout(read, 10)).toBe(true);
  for (const status of [["pending"], ["handled"], undefined, null, "paid", {}, 1]) {
    expect(isCheckoutWalkout({ ...read, receptionHandoff: { status, handledReason: null } }, 10)).toBe(false);
  }
  expect(isCheckoutWalkout({ ...read, signedAt: null }, 10)).toBe(false);
});

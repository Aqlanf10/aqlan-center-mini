import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CheckoutExtras } from "../components/patient/CheckoutExtras";
import { formatMoney } from "../lib/money";
import { buildCheckoutDueRecommendation } from "../lib/checkout-due-recommendation";
const runtime = vi.hoisted(() => ({ cursor: 0, childWalkout: null as Record<string, unknown> | null }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const value = runtime.cursor++ === 0 ? runtime.childWalkout : typeof initial === "function" ? initial() : initial;
    return [value, () => undefined];
  } };
});
const render = (element: ReactNode) => { runtime.cursor = 0; return renderToStaticMarkup(element); };
beforeEach(() => { runtime.childWalkout = null; });
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic", role: "reception", permissions: null }) }));
const props = { visitId: 10, collected: false, suggestedDate: "2026-10-20", durationMinutes: 30, onChanged: () => undefined };
const financialSummary = [{ currency: "YER" as const, previousBalanceMinor: 0, newBillableMinor: 1000, paymentsTodayMinor: 250, currentBalanceMinor: 750, todayRemainingMinor: 750, legacySuggestedMinor: 0, legacyRemainingMinor: 0, dueNowMinor: 750 }];
const dueRecommendation = buildCheckoutDueRecommendation({ patientId: 7, visitInvoiceId: null, current: { YER: 750 }, sources: [] });
describe("checkout extras admits only a present, same-patient financial recommendation", () => {
  it("does not dereference an absent recommendation when optional patient identity is absent", () => {
    expect(render(<CheckoutExtras {...props} />)).not.toContain('data-testid="checkout-due-recommendation"');
  });
  it("does not show absent, denied or another patient's source facts", () => {
    for (const extra of [{ expectedPatientId: 7, dueRecommendation: null }, { expectedPatientId: 8, dueRecommendation },
      { expectedPatientId: 7, dueRecommendation, financialVerified: false }]) {
      const html = render(<CheckoutExtras {...props} financialSummary={financialSummary} {...extra} />);
      expect(html).not.toContain('data-testid="checkout-due-recommendation"');
      expect(html).not.toContain("مدفوع يوم الزيارة");
    }
  });
  it("shows the verified parent's source facts without enabling legacy or aggregate collection", () => {
    const html = render(<CheckoutExtras {...props} expectedPatientId={7} dueRecommendation={dueRecommendation} financialSummary={financialSummary} />);
    expect(html).toContain('data-testid="checkout-due-recommendation"');
    expect(html).toContain('href="/patients/7?tab=account"');
    expect(html).not.toContain("تحصيل قسط الرصيد القديم");
    expect(html).toContain("مدفوع يوم الزيارة");
  });
  it("never borrows paid-today money from the child's independently refreshed clinical read", () => {
    runtime.childWalkout = { visitId: 10, patientId: 7, patientName: "Synthetic", lines: [], orthoAdjustment: null,
      nextAppointment: null, deferred: false, summary: [{ ...financialSummary[0], paymentsTodayMinor: 999 }] };
    const valid = render(<CheckoutExtras {...props} expectedPatientId={7} dueRecommendation={dueRecommendation} financialSummary={financialSummary} />);
    expect(valid).toContain(formatMoney(250, "YER")); expect(valid).not.toContain(formatMoney(999, "YER"));
    const missing = render(<CheckoutExtras {...props} expectedPatientId={7} dueRecommendation={null} financialSummary={null} />);
    expect(missing).not.toContain("مدفوع يوم الزيارة"); expect(missing).not.toContain(formatMoney(999, "YER"));
  });

});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PatientPremiumAccountOverview } from "../components/patient/PatientPremiumAccountOverview";
import { formatMoney } from "../lib/money";
import type { WorkflowSummary } from "../components/patient/SummaryTab";

type Finance = NonNullable<WorkflowSummary["financial"]>;
const one = (patch: Partial<Finance> = {}): Finance => ({
  balanceMinor: 0, invoicedMinor: 0, paidMinor: 0, openingMinor: 0,
  agreedMinor: 0, treatmentDoneMinor: 0, remainingTreatmentMinor: 0,
  ...patch,
});
function summary(financial: Finance | null, canSeeFinancial = true): WorkflowSummary {
  return {
    openVisit: null, lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [],
    counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: false },
    alerts: [], canSeeFinancial, financial,
  };
}
function render(financial: Finance | null, canSeeFinancial = true) {
  return renderToStaticMarkup(createElement(PatientPremiumAccountOverview, {
    summary: summary(financial, canSeeFinancial), base: "YER",
  }));
}

describe("patient premium account presentation", () => {
  it("never renders restricted money when the financial permission is absent", () => {
    const amount = one({ balanceMinor: 7654321, agreedMinor: 1234567 });
    expect(render(amount, false)).toBe("");
    expect(render(null)).toBe("");
    expect(renderToStaticMarkup(createElement(PatientPremiumAccountOverview, {
      summary: null, base: "YER",
    }))).toBe("");
  });

  it("displays distinct debt and agreement amounts without adding them", () => {
    const html = render(one({
      balanceMinor: 2500, agreedMinor: 300000, agreementPaidMinor: 120000,
      agreementRemainingMinor: 180000, invoicedMinor: 20000,
    }));
    expect(html).toContain("المتبقي من الاتفاق");
    expect(html).toContain("الرصيد المستحق حالياً");
    for (const amount of [2500, 300000, 120000, 180000]) {
      expect(html).toContain(formatMoney(amount, "YER"));
    }
    expect(html).not.toContain(formatMoney(182500, "YER"));
  });

  it("keeps currencies in separate cards and does not fabricate missing buckets", () => {
    const financial = one({
      byCurrency: {
        YER: one({ balanceMinor: 2400 }),
        SAR: one({ balanceMinor: 175 }),
        USD: one(),
      },
    });
    const html = render(financial);
    expect(html).toContain('data-testid="patient-finance-overview-YER"');
    expect(html).toContain('data-testid="patient-finance-overview-SAR"');
    expect(html).not.toContain('data-testid="patient-finance-overview-USD"');
    expect(html).toContain(formatMoney(2400, "YER"));
    expect(html).toContain(formatMoney(175, "SAR"));
    // Existing API read can be incomplete; there must not be a fabricated zero bucket.
    const partial = one({ byCurrency: { YER: one({ balanceMinor: 2400 }) } as Finance["byCurrency"] });
    const safe = render(partial);
    expect(safe).toContain('data-testid="patient-finance-overview-YER"');
    expect(safe).not.toContain('data-testid="patient-finance-overview-SAR"');
  });

  it("shows a credit as a patient credit, never as a collectible debt", () => {
    const html = render(one({ balanceMinor: -420 }));
    expect(html).toContain("رصيد لصالح المريض");
    expect(html).not.toContain("الرصيد المستحق حالياً");
    expect(html).toContain(formatMoney(420, "YER"));
  });
});

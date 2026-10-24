import { describe, expect, it } from "vitest";
import { portalHistoricalTreatment } from "../lib/portal-statement";
import { historicalOpeningBuckets, type HistoricalStatementAgreement } from "../lib/statement-historical-details";

/* The portal's «العلاج السابق» is the print's buckets reduced to an allowlist: no document, revision,
 * standalone or kind identifiers reach the patient's browser, and nothing is invented. */
const document: HistoricalStatementAgreement = {
  kind: "document", id: 9041, version: 3, currency: "YER", historicalAsOf: "2025-05-01",
  lines: [
    { description: "حشوة عصب تجريبية", site: "45", quantity: 1, unitPriceMinor: 200_000, discountMinor: 20_000, netMinor: 180_000 },
    { description: "تاج تجريبي", site: null, quantity: 1, unitPriceMinor: 300_000, discountMinor: 30_000, netMinor: 270_000 },
  ],
  grossMinor: 500_000, discountMinor: 50_000, agreedMinor: 450_000, previouslyPaidMinor: 150_000, remainingMinor: 300_000,
};
const standalone: HistoricalStatementAgreement = {
  kind: "standalone", id: 77, version: 1, currency: "SAR", historicalAsOf: "2025-02-10",
  lines: [{ description: "تقويم سابق تجريبي", site: null, quantity: 1, unitPriceMinor: null, discountMinor: null, netMinor: 150_050 }],
  grossMinor: null, discountMinor: null, agreedMinor: 150_050, previouslyPaidMinor: 50_000, remainingMinor: 100_050,
};

describe("portalHistoricalTreatment", () => {
  it("projects the print buckets to the allowed fields only, in YER, SAR, USD bucket order", () => {
    const buckets = historicalOpeningBuckets([standalone, document], [{ currency: "YER", amountMinor: 300_000 }, { currency: "SAR", amountMinor: 120_050 }], []);
    const view = portalHistoricalTreatment(buckets);
    expect(view.available).toBe(true);
    if (!view.available) return;
    expect(view.agreements.map((agreement) => agreement.currency)).toEqual(["YER", "SAR"]);
    for (const agreement of view.agreements) {
      expect(Object.keys(agreement).sort()).toEqual(["agreedMinor", "currency", "discountMinor", "grossMinor", "historicalAsOf", "lines", "previouslyPaidMinor", "remainingMinor"]);
      for (const line of agreement.lines) expect(Object.keys(line).sort()).toEqual(["description", "discountMinor", "netMinor", "quantity", "site", "unitPriceMinor"]);
    }
    expect(JSON.stringify(view)).not.toMatch(/9041|"version"|"kind"|"id"/);
    expect(view.agreements[0]).toEqual({ historicalAsOf: "2025-05-01", currency: "YER", lines: document.lines,
      grossMinor: 500_000, discountMinor: 50_000, agreedMinor: 450_000, previouslyPaidMinor: 150_000, remainingMinor: 300_000 });
    // Standalone agreements record no gross, discount or unit price: they stay null, never an invented zero.
    expect(view.agreements[1]).toMatchObject({ grossMinor: null, discountMinor: null, lines: [{ unitPriceMinor: null, discountMinor: null, netMinor: 150_050 }] });
    // SAR opening 120,050 vs historical remaining 100,050: part of the previous balance has no stored detail.
    expect(view.undetailed).toEqual([{ currency: "SAR", partial: true }]);
  });

  it("reports a manual opening with no stored detail, and no agreements, without inferring any", () => {
    expect(portalHistoricalTreatment(historicalOpeningBuckets([], [{ currency: "USD", amountMinor: 5_000 }], [])))
      .toEqual({ available: true, agreements: [], undetailed: [{ currency: "USD", partial: false }] });
  });

  it("withholds the whole section when a saved historical fact failed validation", () => {
    expect(portalHistoricalTreatment(null)).toEqual({ available: false });
  });
});

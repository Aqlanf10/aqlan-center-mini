import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { historicalClinicalProgress, combineClinicalProgress } from "../lib/historical-clinical-projection";
import { HistoricalClinicalNote } from "../components/HistoricalClinicalNote";
import { formatMoney } from "../lib/money";

const old = { serviceId: 1, toothCode: null, quantity: 1, unitPriceMinor: 300000, status: "planned" as const, legacyAgreementId: 4 };
const known = { serviceId: 2, toothCode: null, quantity: 2, unitPriceMinor: 5000, status: "planned" as const };

describe("DOT-PF14 clinical display, independent of debt", () => {
  it("does not infer historical progress from agreed money, status, or void identity", () => {
    for (const status of ["planned", "done", "cancelled"] as const) {
      expect(historicalClinicalProgress([{ ...old, status }])).toEqual({ historicalItems: 1,
        knownItems: 0, knownDoneItems: 0, knownDoneMinor: 0, knownRemainingMinor: 0 });
    }
  });
  it("preserves ordinary progress and excludes cancelled ordinary work", () => {
    expect(historicalClinicalProgress([known, { ...known, status: "done" }, { ...known, status: "cancelled" }]))
      .toEqual({ historicalItems: 0, knownItems: 2, knownDoneItems: 1, knownDoneMinor: 10000, knownRemainingMinor: 10000 });
  });
  it.each(["YER", "SAR", "USD"] as const)("shows unknown history and known mixed work in original %s", (currency) => {
    const progress = combineClinicalProgress([historicalClinicalProgress([old]), historicalClinicalProgress([known])]);
    const html = renderToStaticMarkup(createElement(HistoricalClinicalNote, { progress, currency }));
    expect(html).toContain("الباقي السريري غير معلومين");
    expect(html).toContain("باقي علاج معروف (غير مستحق)");
    expect(html).toContain(formatMoney(10000, currency));
    expect(html).not.toContain(formatMoney(300000, currency));
    expect(progress.knownRemainingMinor).toBe(10000);
    expect(old).toEqual({ serviceId: 1, toothCode: null, quantity: 1, unitPriceMinor: 300000, status: "planned", legacyAgreementId: 4 });
  });
});

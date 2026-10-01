import { describe, expect, it } from "vitest";
import { legacyOnboarding } from "../lib/legacy-onboarding";

/** (P1-A) قائمة تهيئة مريض التقويم السابق — بالمصنِّف نفسه الذي يقرر فوترة الشدّة عند التوقيع. */
describe("(P1-A) legacyOnboarding", () => {
  const base = { legacy: true, openingCurrencies: [] as string[], activeArrangementCurrencies: [] as string[], fundedPlan: false };

  it("a case started in the system has no onboarding", () => {
    expect(legacyOnboarding({ ...base, legacy: false, financialMode: null })).toMatchObject({ legacy: false, steps: [], complete: true });
  });

  it("an undecided financial mode is incomplete and warns that today's adjustment is outside the contract", () => {
    const result = legacyOnboarding({ ...base, financialMode: null });
    expect(result.complete).toBe(false);
    expect(result.adjustmentClass).toBe("OUTSIDE_CONTRACT");
    expect(result.warning).toMatch(/لن تُعدّ مشمولة/);
    expect(result.steps.find((step) => step.key === "financial_mode")?.done).toBe(false);
  });

  it("opening_balance without a recorded opening balance is incomplete — the adjustment is not covered", () => {
    const result = legacyOnboarding({ ...base, financialMode: "opening_balance" });
    expect(result.complete).toBe(false);
    expect(result.adjustmentClass).toBe("OUTSIDE_CONTRACT");
    expect(result.steps.find((step) => step.key === "opening_balance")).toMatchObject({ done: false, optional: false });
    expect(result.warning).not.toBeNull();
  });

  it("opening_balance with one currency is complete and covered; the arrangement stays optional", () => {
    const result = legacyOnboarding({ ...base, financialMode: "opening_balance", openingCurrencies: ["YER"] });
    expect(result.complete).toBe(true);
    expect(result.adjustmentClass).toBe("LEGACY_INCLUDED");
    expect(result.warning).toBeNull();
    expect(result.steps.find((step) => step.key === "arrangement")).toMatchObject({ done: false, optional: true });
    const arranged = legacyOnboarding({
      ...base, financialMode: "opening_balance", openingCurrencies: ["YER"], activeArrangementCurrencies: ["YER"],
    });
    expect(arranged.steps.find((step) => step.key === "arrangement")?.done).toBe(true);
  });

  it("an opening balance in two currencies is not guessed — incomplete with an explicit hint", () => {
    const result = legacyOnboarding({ ...base, financialMode: "opening_balance", openingCurrencies: ["SAR", "YER"] });
    expect(result.complete).toBe(false);
    expect(result.adjustmentClass).toBe("OUTSIDE_CONTRACT");
    expect(result.steps.find((step) => step.key === "opening_balance")?.hint).toMatch(/أكثر من عملة/);
  });

  it("installments need a funded plan", () => {
    expect(legacyOnboarding({ ...base, financialMode: "installments" })).toMatchObject({ complete: false, adjustmentClass: "OUTSIDE_CONTRACT" });
    expect(legacyOnboarding({ ...base, financialMode: "installments", fundedPlan: true })).toMatchObject({ complete: true, warning: null });
  });

  it("prepaid is complete and covered; per_session is complete and billed per visit without a warning", () => {
    expect(legacyOnboarding({ ...base, financialMode: "prepaid_included" })).toMatchObject({ complete: true, adjustmentClass: "LEGACY_INCLUDED", warning: null });
    const perSession = legacyOnboarding({ ...base, financialMode: "per_session" });
    expect(perSession.complete).toBe(true);
    expect(perSession.warning).toBeNull();
  });
});

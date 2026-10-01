import { describe, expect, it } from "vitest";
import { classifyOrthoAdjustment, classifyPlanSession } from "../lib/billing-classification";

describe("billing classification", () => {
  it("keeps BILL-1 plan sessions on their agreement source", () => {
    expect(classifyPlanSession(true)).toBe("INCLUDED");
    expect(classifyPlanSession(false)).toBe("NEW_BILLABLE");
  });

  it("includes a pre-system adjustment only when its financial coverage is evidenced", () => {
    const legacy = { legacy: true, fundedPlan: false };
    expect(classifyOrthoAdjustment({ ...legacy, financialMode: "opening_balance", openingCurrencies: ["YER"] }))
      .toBe("LEGACY_INCLUDED");
    expect(classifyOrthoAdjustment({ ...legacy, financialMode: "opening_balance", openingCurrencies: [] }))
      .toBe("OUTSIDE_CONTRACT");
    expect(classifyOrthoAdjustment({ ...legacy, financialMode: "opening_balance", openingCurrencies: ["YER", "USD"] }))
      .toBe("OUTSIDE_CONTRACT");
    expect(classifyOrthoAdjustment({ ...legacy, financialMode: "prepaid_included", openingCurrencies: [] }))
      .toBe("LEGACY_INCLUDED");
  });

  it("never calls a clinical-only adjustment newly billed", () => {
    const input = { legacy: true, openingCurrencies: ["YER"], fundedPlan: false };
    expect(classifyOrthoAdjustment({ ...input, financialMode: "per_session" })).toBe("OUTSIDE_CONTRACT");
    expect(classifyOrthoAdjustment({ ...input, financialMode: "installments" })).toBe("OUTSIDE_CONTRACT");
    expect(classifyOrthoAdjustment({ ...input, financialMode: "installments", fundedPlan: true }))
      .toBe("INCLUDED");
    expect(classifyOrthoAdjustment({ ...input, legacy: false, financialMode: "opening_balance" }))
      .toBe("OUTSIDE_CONTRACT");
  });

  it("(P1-B) a new orthodontic package: adjustments are included only while an agreement funds the case", () => {
    const fresh = { legacy: false, financialMode: null, openingCurrencies: [] };
    expect(classifyOrthoAdjustment({ ...fresh, fundedPlan: true })).toBe("INCLUDED");
    expect(classifyOrthoAdjustment({ ...fresh, fundedPlan: false })).toBe("OUTSIDE_CONTRACT");
    /* رصيدٌ سابق لا يغطّي حالةً جديدة — التغطية من الاتفاق وحده. */
    expect(classifyOrthoAdjustment({ ...fresh, openingCurrencies: ["YER"], fundedPlan: false })).toBe("OUTSIDE_CONTRACT");
  });
});

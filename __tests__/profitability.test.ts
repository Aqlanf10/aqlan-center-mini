import { describe, expect, it } from "vitest";
import {
  calculateProcedureProfitability,
  calculateCaseProfitability,
  determineProfitabilityTier,
  PROFITABILITY_TIER_META,
} from "../lib/profitability";

describe("lib/profitability (Case Profitability & Margin Inspector)", () => {
  it("determines profitability tiers correctly based on margin thresholds", () => {
    expect(determineProfitabilityTier(65)).toBe("excellent");
    expect(determineProfitabilityTier(55)).toBe("excellent");
    expect(determineProfitabilityTier(45)).toBe("healthy");
    expect(determineProfitabilityTier(35)).toBe("healthy");
    expect(determineProfitabilityTier(25)).toBe("tight");
    expect(determineProfitabilityTier(15)).toBe("loss_risk");
    expect(determineProfitabilityTier(-10)).toBe("loss_risk");
  });

  it("calculates procedure profitability accurately", () => {
    // مثال: تاج زيركون بسعر 100,000 ريال، تكلفة معمل 30,000 ريال، مواد 5,000 ريال، عمولة طبيب 20,000 ريال
    const result = calculateProcedureProfitability({
      serviceName: "تاج زيركون مونوكليت",
      revenueMinor: 100000,
      labCostMinor: 30000,
      materialCostMinor: 5000,
      doctorCommissionMinor: 20000,
    });

    expect(result.totalDirectCostMinor).toBe(55000);
    expect(result.netContributionMinor).toBe(45000);
    expect(result.marginPercent).toBe(45);
    expect(result.tier).toBe("healthy");
  });

  it("calculates multi-procedure case profitability aggregate", () => {
    const items = [
      {
        serviceName: "تنظيف وتلميع أسنان",
        revenueMinor: 20000,
        labCostMinor: 0,
        materialCostMinor: 2000,
        doctorCommissionMinor: 5000,
      },
      {
        serviceName: "علاج عصب ثلاثي الأقنية",
        revenueMinor: 60000,
        labCostMinor: 0,
        materialCostMinor: 6000,
        doctorCommissionMinor: 18000,
      },
      {
        serviceName: "تاج خزف على زركونيا",
        revenueMinor: 120000,
        labCostMinor: 40000,
        materialCostMinor: 5000,
        doctorCommissionMinor: 24000,
      },
    ];

    const caseSummary = calculateCaseProfitability(items);
    expect(caseSummary.totalRevenueMinor).toBe(200000);
    expect(caseSummary.totalLabCostMinor).toBe(40000);
    expect(caseSummary.totalMaterialCostMinor).toBe(13000);
    expect(caseSummary.totalDoctorCommissionMinor).toBe(47000);
    expect(caseSummary.totalDirectCostsMinor).toBe(100000);
    expect(caseSummary.netClinicProfitMinor).toBe(100000);
    expect(caseSummary.overallMarginPercent).toBe(50);
    expect(caseSummary.tier).toBe("healthy");
    expect(caseSummary.procedures.length).toBe(3);
  });

  it("flags high lab cost procedures as tight or loss risk", () => {
    // حالة معمل مرتفعة بدون تسعير مناسب
    const result = calculateProcedureProfitability({
      serviceName: "طقم أسنان كامل",
      revenueMinor: 100000,
      labCostMinor: 70000,
      materialCostMinor: 5000,
      doctorCommissionMinor: 20000,
    });

    expect(result.totalDirectCostMinor).toBe(95000);
    expect(result.netContributionMinor).toBe(5000);
    expect(result.marginPercent).toBe(5);
    expect(result.tier).toBe("loss_risk");
  });
});

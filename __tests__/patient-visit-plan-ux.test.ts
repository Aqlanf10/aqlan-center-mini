import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { zeroDueReason } from "../lib/billing-classification";
import { catalogPriceFor } from "../lib/service-pricing";

/**
 * (P1–P6) قواعد الحزمة الخالصة: سبب «لا استحقاق» مشتقٌّ من التصنيف وحده، والسعر المعروض
 * من الدليل بعملة السياق — ولا مدخل في أي مسار يصفّر المستحق يدويًا.
 */
describe("(P6) zeroDueReason comes from the billing decision", () => {
  const line = (classification: "INCLUDED" | "NEW_BILLABLE", amountMinor = 0, planLinked = true) =>
    ({ classification, amountMinor, planLinked });

  it("names the agreement, the legacy ortho cover, and a documentation-only visit", () => {
    expect(zeroDueReason([line("INCLUDED")], null)).toBe("مشمولة ضمن اتفاق الأقساط");
    expect(zeroDueReason([], "LEGACY_INCLUDED")).toBe("شدّة تقويم مشمولة بالعلاج السابق");
    expect(zeroDueReason([], "INCLUDED")).toBe("شدّة تقويم مشمولة ضمن اتفاق الأقساط");
    expect(zeroDueReason([], "OUTSIDE_CONTRACT")).toBe("زيارة توثيق بلا إجراء مفوتر");
    expect(zeroDueReason([], null)).toBe("زيارة توثيق بلا إجراء مفوتر");
  });

  it("distinguishes a plan session the rule does not bill today from a zero-priced procedure", () => {
    expect(zeroDueReason([line("NEW_BILLABLE", 0, true)], null)).toBe("الجلسة الحالية غير مستحقة حسب قاعدة فوترة الخطة");
    expect(zeroDueReason([line("NEW_BILLABLE", 0, false)], null)).toBe("إجراء بقيمة صفر مقررة من الدليل أو الخطة");
  });

  it("no route or helper accepts a caller-provided 'force zero' / waiver", () => {
    for (const file of [
      "app/api/visits/[id]/billing-preview/route.ts",
      "app/api/visits/[id]/clinical/route.ts",
      "components/ClinicalVisit.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/forceZero|force_zero|waive|zeroDue\s*:\s*true/i);
    }
    const preview = readFileSync("app/api/visits/[id]/billing-preview/route.ts", "utf8");
    expect(preview).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });
});

describe("(P3) catalogPriceFor shows the catalog price in the context currency", () => {
  const service = {
    priceMinor: 25000, priceConfigured: true, priceProvisional: false,
    priceIn: { YER: { minor: 25000, source: "catalog" as const }, SAR: { minor: 6000, source: "converted" as const }, USD: { minor: null, source: "none" as const } },
  };

  it("uses the server's per-currency price, never the YER number under another currency", () => {
    expect(catalogPriceFor(service, "YER")).toEqual({ minor: 25000, state: "ok" });
    expect(catalogPriceFor(service, "SAR")).toEqual({ minor: 6000, state: "ok" });
    expect(catalogPriceFor(service, "USD")).toEqual({ minor: null, state: "no_rate" });
  });

  it("labels provisional prices and refuses an unconfigured one", () => {
    expect(catalogPriceFor({ ...service, priceProvisional: true }, "YER")).toEqual({ minor: 25000, state: "provisional" });
    expect(catalogPriceFor({ ...service, priceConfigured: false }, "YER")).toEqual({ minor: null, state: "unconfigured" });
  });
});

describe("(P2/P5) quick plans post to the one V2 plan engine", () => {
  it("both quick forms send mode v2 to /api/plans and no other plan endpoint exists", () => {
    for (const file of ["components/QuickPlanForm.tsx", "components/QuickAgreementPlanForm.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/fetch\("\/api\/plans"/);
      expect(source).toMatch(/mode: "v2"/);
      expect(source).not.toMatch(/\/api\/quick-plan|quick_plans/);
    }
  });

  it("the quick plan sends catalog prices only — no free price field", () => {
    const source = readFileSync("components/QuickPlanForm.tsx", "utf8");
    expect(source).toMatch(/unitPriceMinor: price\.minor/);
    expect(source).not.toMatch(/priceReason/);
  });
});

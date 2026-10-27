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
    expect(zeroDueReason([line("INCLUDED")], null)).toBe("مشمولة بالتغطية المالية المسجّلة");
    expect(zeroDueReason([], "LEGACY_INCLUDED")).toBe("شدّة تقويم مشمولة بالعلاج السابق");
    expect(zeroDueReason([], "INCLUDED")).toBe("شدّة تقويم مشمولة بالتغطية المالية المسجّلة");
    expect(zeroDueReason([], "OUTSIDE_CONTRACT")).toContain("معلّق");
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

describe("(P2/P5) treatment creation uses the canonical invoice or historical writer", () => {
  it("Plans opens the shared entry; its old independent forms cannot create a plan", () => {
    const plans = readFileSync("components/PatientPlans.tsx", "utf8");
    expect(plans).toContain('data-testid="plans-open-treatment-entry"');
    expect(plans).toContain("onOpenTreatmentEntry()");
    expect(plans).not.toMatch(/QuickPlanForm|QuickAgreementPlanForm|TemplatePlanForm|fetch\("\/api\/plans"/);
    const ledger = readFileSync("components/PatientLedger.tsx", "utf8");
    expect(ledger).toContain('<TreatmentEntryChoice');
    expect(ledger).toContain('fetch("/api/invoices"');
    expect(ledger).toContain('fetch(`/api/patients/${patientId}/historical-documents`');
    expect(ledger).not.toMatch(/fetch\("\/api\/plans"|\/api\/quick-plan|quick_plans/);
  });

  it("canonical creation retains server catalog authority and authorized override reasons", () => {
    const parser = readFileSync("lib/invoice-input.ts", "utf8");
    expect(parser).toContain("services.get(serviceId)");
    expect(parser).toContain("service.name");
    const route = readFileSync("app/api/invoices/route.ts", "utf8");
    expect(route).toContain("checkInvoiceAuthority(");
    expect(route).toContain("role: session.role");
    expect(route).toContain('settings["billing.max_discount_percent"]');
    expect(route.indexOf("if (!authority.ok)")).toBeLessThan(route.indexOf("await createLinkedInvoice("));
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LegacyPlanPrintSummary } from "../components/LegacyPlanPrintSummary";
import { formatMoney } from "../lib/money";

const item = { id: 1, serviceName: "Historical bridge", toothCode: 14, totalMinor: 300_000,
  legacyAgreementId: 5, legacyAgreementStatus: "live" as const, billingStatus: "included_in_package",
  legacyCoverageState: "verified" as const, legacyCurrentConsentRequired: false,
  legacyCoverageSite: { mode: "multi_tooth_episode" as const, toothCode: 14, surfaces: null, episodeTeeth: [14, 15, 16], scope: null } };
const plan = { id: 9, title: "Historical plan", patientName: "Patient", totalMinor: 300_000,
  consentAt: "2026-09-30", consentBy: "admin", consentNote: "Retained evidence", items: [item] };
const render = (patch = {}) => renderToStaticMarkup(createElement(LegacyPlanPrintSummary,
  { plan: { ...plan, items: [{ ...item, ...patch }] }, currency: "YER" }));

describe("historical plan print parity", () => {
  it("prints the immutable full episode as reference without a new contract, debt or invented progress", () => {
    const html = render();
    expect(html).toContain("مرجع تاريخي للقراءة فقط");
    expect(html).toContain("أسنان الحلقة: 14، 15، 16");
    expect(html).toContain("تقدّم العلاج السابق غير معلوم");
    expect(html).toContain("المستحق الحالي يؤخذ من حساب المريض فقط");
    expect(html).toContain("موافقة العلاج الحالية المسجّلة");
    expect(html).not.toContain("المتبقي من قيمة الخطة");
    expect(html).not.toContain("إقرار وموافقة المريض (أو ولي أمره)");
    expect(html).not.toContain(formatMoney(900_000, "YER"));
  });
  it.each(["unknown", "conflict", undefined])("retains the old timestamp without asserting current consent for %s", (state) => {
    const html = render({ legacyCoverageState: state, legacyCoverageSite: null, legacyCurrentConsentRequired: true });
    expect(html).toContain("تاريخ موافقة محفوظ غير متحقق للموافقة الحالية");
    expect(html).toContain("Retained evidence");
    expect(html).toContain("الموافقة الحالية غير متحققة");
    expect(html).not.toContain("موافقة العلاج الحالية المسجّلة");
    expect(html).not.toContain("أسنان الحلقة:");
    expect(plan.consentAt).toBe("2026-09-30");
  });
  it("requires genuine new consent even when immutable coverage is verified", () => {
    expect(render({ legacyCurrentConsentRequired: true })).toContain("الموافقة الحالية غير متحققة");
  });
  it("keeps authentication and the ordinary contract path while branching history before contract construction", () => {
    const source = readFileSync(new URL("../app/print/plan/[id]/page.tsx", import.meta.url), "utf8");
    expect(source).toContain("if (!session || !canHandleMoney(session.role)) notFound()");
    expect(source.indexOf("if (plan.items.some(hasLegacyHistory))")).toBeLessThan(source.indexOf("const agreement = buildInstallmentPlanAgreement"));
    expect(source).toContain('title="اتفاقية خطة العلاج وجدول الأقساط"');
    expect(source).toContain("إقرار وموافقة المريض (أو ولي أمره)");
  });
});

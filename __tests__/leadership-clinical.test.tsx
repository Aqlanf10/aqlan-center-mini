import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LeadershipClinicalReadout } from "../components/leadership/LeadershipClinicalOverview";
import { decodeLeadershipClinical, leadershipClinicalHref, leadershipClinicalUrl, type LeadershipClinicalSource } from "../lib/leadership-clinical";
import { formatMoney } from "../lib/money";

function payload(report: LeadershipClinicalSource = "unscheduled-treatment") {
  const pending = { patientId: 1, patientName: "مريض اصطناعي", planTitle: "خطة اصطناعية", doctorName: "طبيب اصطناعي", startDate: "2026-01-01", lastVisit: "", pendingItems: 2, pendingMinor: 12345, currency: "SAR", phone: "PRIVATE_PHONE", salaryMinor: 999999, privateTask: "PRIVATE_TASK" };
  const doctor = { doctorId: 7, doctorName: "طبيب اصطناعي", appointments: 3, attended: 1, noShow: 1, visits: 1, chairMinutes: 0, avgVisitMinutes: null, productionText: `${formatMoney(12345, "SAR")} · ${formatMoney(555, "USD")}`, collectedText: formatMoney(1134, "SAR"), salaryMinor: 999999, commissionPercent: 70 };
  const plan = { dimension: "الطبيب", name: "طبيب اصطناعي", currency: "SAR", plans: 3, active: 1, completed: 1, stopped: 1, remainingMinor: 12345 };
  const keys = report === "unscheduled-treatment" ? [["plans", 1], ["patients", 1], ["items", 2]] : report === "plan-intelligence" ? [["created", 3], ["active", 1], ["completed", 1], ["stopped", 1]] : [["doctors", 1], ["appointments", 3], ["visits", 1], ["chair-minutes", 0]];
  const prefix = report === "unscheduled-treatment" ? "pending" : "remaining";
  return {
    result: { report, from: "2026-10-01", to: "2026-10-26", baseCurrency: "YER", rows: [report === "unscheduled-treatment" ? pending : report === "provider-utilization" ? doctor : plan] as Record<string, unknown>[],
      kpis: [...keys.map(([key, count]) => ({ key, count })), ...(report === "provider-utilization" ? [] : [{ key: prefix, minor: 0, currency: "YER" }, { key: `${prefix}-SAR`, minor: 12345, currency: "SAR" }, { key: `${prefix}-USD`, minor: 555, currency: "USD" }])],
      notes: ["PRIVATE_NOTE"],
    }, generatedAt: "2026-10-26T09:00:00Z", generatedBy: "synthetic_admin", clinicTimeZone: "Asia/Aden",
  };
}

describe("leadership clinical source boundary", () => {
  it("accepts each actual report shape and strips fields outside the leadership projection", () => {
    for (const source of ["unscheduled-treatment", "plan-intelligence", "provider-utilization"] as const) {
      const decoded = decodeLeadershipClinical(payload(source), source);
      expect(decoded).not.toBeNull();
      expect(JSON.stringify(decoded)).not.toMatch(/PRIVATE_|salaryMinor|commissionPercent|generatedBy/);
    }
  });
  it("fails closed for wrong source, impossible date, invalid timezone or missing counts", () => {
    expect(decodeLeadershipClinical(payload(), "plan-intelligence")).toBeNull();
    const invalidDate = payload(); invalidDate.result.from = "2026-02-30";
    expect(decodeLeadershipClinical(invalidDate, "unscheduled-treatment")).toBeNull();
    const wrongZone = payload(); wrongZone.clinicTimeZone = "wrong/timezone";
    expect(decodeLeadershipClinical(wrongZone, "unscheduled-treatment")).toBeNull();
    const missingCount = payload(); missingCount.result.kpis.shift();
    expect(decodeLeadershipClinical(missingCount, "unscheduled-treatment")).toBeNull();
  });
  it("never accepts unknown money, a missing currency, duplicate currency or partial row populations as zero", () => {
    const missing = payload(); Reflect.deleteProperty(missing.result.kpis[3], "minor");
    expect(decodeLeadershipClinical(missing, "unscheduled-treatment")).toBeNull();
    const unknownCurrency = payload(); Reflect.set(unknownCurrency.result.kpis[3], "currency", "unknown");
    expect(decodeLeadershipClinical(unknownCurrency, "unscheduled-treatment")).toBeNull();
    const duplicate = payload(); duplicate.result.kpis.push(duplicate.result.kpis[3]);
    expect(decodeLeadershipClinical(duplicate, "unscheduled-treatment")).toBeNull();
    const partial = payload(); partial.result.rows = [];
    expect(decodeLeadershipClinical(partial, "unscheduled-treatment")).toBeNull();
  });
  it("does not convert null doctor time into zero or accept an unknown row count", () => {
    const source = payload("provider-utilization");
    expect(decodeLeadershipClinical(source, "provider-utilization")!.rows[0].avgVisitMinutes).toBeNull();
    source.result.rows[0].visits = null;
    expect(decodeLeadershipClinical(source, "provider-utilization")).toBeNull();
  });
  it("keeps current pending work independent of a selected reporting period and builds canonical drilldowns", () => {
    expect(leadershipClinicalUrl("unscheduled-treatment", "prev_month")).toBe("/api/reports?report=unscheduled-treatment&preset=today");
    expect(leadershipClinicalUrl("provider-utilization", "prev_month")).toContain("preset=prev_month");
    const read = decodeLeadershipClinical(payload("provider-utilization"), "provider-utilization")!;
    expect(leadershipClinicalHref(read, 7)).toBe("/reports?section=intelligence&report=provider-utilization&preset=custom&from=2026-10-01&to=2026-10-26&doctorId=7");
  });
});

describe("leadership clinical presentation", () => {
  it("shows currencies unchanged with explicit non-debt scope, current backlog limits and record links", () => {
    const read = decodeLeadershipClinical(payload(), "unscheduled-treatment")!;
    const html = renderToStaticMarkup(<LeadershipClinicalReadout read={read} />);
    expect(html).toContain(formatMoney(12345, "SAR"));
    expect(html).toContain(formatMoney(555, "USD"));
    expect(html).not.toContain(formatMoney(12900, "YER"));
    expect(html).toContain("ليست مديونية");
    expect(html).toContain("ولو كان الموعد لعمل آخر");
    expect(html).toContain('href="/patients/1"');
    expect(html).toContain("ليست هذه قائمة شاملة");
    expect(html).not.toMatch(/PRIVATE_|999999|<table/);
  });
  it("renders known doctor work and unknown capacity without disclosing salary or inventing profit", () => {
    const read = decodeLeadershipClinical(payload("provider-utilization"), "provider-utilization")!;
    const html = renderToStaticMarkup(<LeadershipClinicalReadout read={read} />);
    expect(html).toContain("أطباء لهم سجلات في الفترة");
    expect(html).toContain("غير معروف؛ لا وقتين صالحين");
    expect(html).toContain("نسبة الاستغلال غير معروفة");
    expect(html).toContain("لا تُنسب مصروفات العيادة إلى طبيب");
    expect(html).toContain(formatMoney(12345, "SAR"));
    expect(html).toContain(formatMoney(555, "USD"));
    expect(html).not.toContain("999999");
    expect(html).not.toContain("70%");
    expect(html).not.toContain("0%");
  });
  it("makes started-in-period plan status distinct from all current outstanding work", () => {
    const read = decodeLeadershipClinical(payload("plan-intelligence"), "plan-intelligence")!;
    const html = renderToStaticMarkup(<LeadershipClinicalReadout read={read} />);
    expect(html).toContain("خطط بدأت 2026-10-01 إلى 2026-10-26");
    expect(html).toContain("وليست كل الأعمال المتبقية في العيادة");
    expect(html).toContain("تشمل كل حالات خطط الفترة");
    expect(html).toContain("حسب الطبيب والتخصص والعملة");
  });
  it("caps only the visible evidence list while preserving full source totals and an exact full-report action", () => {
    const source = payload(); source.result.rows = Array.from({ length: 13 }, (_, i) => ({ ...source.result.rows[0], patientId: i + 1, patientName: `synthetic-${i + 1}` }));
    Reflect.set(source.result.kpis[0], "count", 13); Reflect.set(source.result.kpis[1], "count", 13); Reflect.set(source.result.kpis[2], "count", 26);
    const read = decodeLeadershipClinical(source, "unscheduled-treatment")!;
    const html = renderToStaticMarkup(<LeadershipClinicalReadout read={read} />);
    expect(html).toContain("يعرض 10 من 13");
    expect(html).toContain("synthetic-10"); expect(html).not.toContain("synthetic-11");
    expect(html).toContain("فتح التقرير الكامل");
    expect(html).toContain("13");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: "admin", username: "synthetic" }) }));
import { DentalChart, PerioChartView } from "../components/DentalChart";
import { PERMANENT_LOWER, PERMANENT_UPPER, type ToothPerioRecord } from "../lib/dental";

const renderPerio = (records: Record<number, ToothPerioRecord> = {}) => renderToStaticMarkup(createElement(PerioChartView, {
  teethUpper: PERMANENT_UPPER, teethLower: PERMANENT_LOWER, system: "fdi", records,
  onUpdate: () => { throw new Error("Unavailable chart must not record a measurement"); }, canEdit: true,
}));

describe("unpersisted periodontal chart containment", () => {
  it("defaults to an explicit unavailable/not-recorded notice without fabricated normal values", () => {
    const html = renderPerio();
    expect(html).toContain('role="alert"');
    expect(html).toContain("قياسات اللثة غير محفوظة");
    expect(html).toContain("هذه الشاشة القديمة لا تحفظ أو تعرض");
    expect(html).toContain("مساحة فحص اللثة في ملف المريض");
    expect(html).not.toContain("ملاحظات الزيارة السريرية");
    expect(html).not.toContain("حتى يتوفر سجل");
    expect(html).not.toMatch(/<select|<input|<button/);
    expect(html).not.toContain("2 mm");
    expect(html).not.toContain("سليم");
  });

  it("does not present even old in-memory values as persisted clinical findings", () => {
    const html = renderPerio({ 18: { toothCode: 18,
      facial: [{ depth: 5, bleeding: true }, { depth: 2, bleeding: false }, { depth: 2, bleeding: false }],
      lingual: [{ depth: 2, bleeding: false }, { depth: 2, bleeding: false }, { depth: 2, bleeding: false }],
    } });
    expect(html).toContain("لا تُعرض قياسات محفوظة في هذه الشاشة");
    expect(html).not.toMatch(/<select|<input|<button/);
  });

  it("preserves the ordinary odontogram and keeps the standalone legacy entry point fail-closed", () => {
    const html = renderToStaticMarkup(createElement(DentalChart, { patientId: 1 }));
    expect(html).toContain("مخطط الأسنان");
    expect(html).toContain("إظهار الأسنان اللبنية");
    expect(html).not.toContain("قياسات اللثة غير محفوظة");
    const source = readFileSync(new URL("../components/DentalChart.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<PerioChartView[\s\S]*?canEdit=\{false\}[\s\S]*?recordingAvailable=\{false\}/);
    expect(source).toContain("/api/patients/${patientId}/chart");
  });
});

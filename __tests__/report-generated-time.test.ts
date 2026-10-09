import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportView } from "../components/reports/ReportView";
import { PrintFrame } from "../components/reports/shared";
import { EMPTY_REPORT_VIEW } from "../lib/report-view";
import { formatReportGeneratedAt } from "../lib/report-generated-time";
import type { ReportResult } from "../lib/reports-types";

vi.mock("../components/Icon", () => ({ Icon: () => null, Logo: () => null }));
vi.mock("../components/SettingsProvider", () => ({ useSetting: () => "" }));
// The canonical date/time formatter and its dependencies remain real.
afterEach(() => { vi.unstubAllEnvs(); });

const result: ReportResult = {
  report: "daily", title: "Synthetic report", from: "2000-02-01", to: "2000-02-02",
  periodLabel: "Synthetic period", filtersLabel: "", baseCurrency: "YER", kpis: [],
};
const cases = [
  { at: "2000-02-02T02:00:00.000Z", zone: "America/New_York", expected: "الثلاثاء 01/02/2000 · 9:00 مساءً" },
  { at: "2000-02-02T20:59:00.000Z", zone: "Asia/Aden", expected: "الأربعاء 02/02/2000 · 11:59 مساءً" },
  { at: "2000-02-02T21:00:00.000Z", zone: "Asia/Aden", expected: "الخميس 03/02/2000 · 12:00 صباحًا" },
  { at: "2000-02-02T22:00:00.000Z", zone: undefined, expected: "الأربعاء 02/02/2000 · 10:00 مساءً (UTC)" },
  { at: "2000-02-02T22:00:00.000Z", zone: "invalid-zone", expected: "الأربعاء 02/02/2000 · 10:00 مساءً (UTC)" },
  { at: "not-an-instantZ", zone: "Asia/Aden", expected: "—" },
  { at: "2026-02-30T12:00:00Z", zone: "Asia/Aden", expected: "—" },
];

describe.each(["UTC", "Pacific/Honolulu"])("report generation metadata with host TZ=%s", (hostZone) => {
  it.each(cases)("renders $at in $zone consistently on screen and page-print", ({ at, zone, expected }) => {
    vi.stubEnv("TZ", hostZone);
    const generated = Object.freeze({ at, by: "synthetic author", clinicTimeZone: zone });
    const html = renderToStaticMarkup(createElement(ReportView, {
      result, clinicName: "Synthetic clinic", generated,
      printHref: "/print/report?report=daily", view: EMPTY_REPORT_VIEW,
      onViewChange: () => {}, onPatientClick: () => {},
    }));
    // ReportView includes the real PrintFrame: two displays, one unchanged instant.
    expect(html.split(`أُنشئ في ${expected} بواسطة synthetic author`)).toHaveLength(3);
    const print = renderToStaticMarkup(createElement(PrintFrame, {
      result, clinicName: "Synthetic clinic", generated,
    }));
    expect(print).toContain(`أُنشئ في ${expected} بواسطة synthetic author`);
    expect(generated.at).toBe(at);
    expect(result.from).toBe("2000-02-01");
    expect(result.to).toBe("2000-02-02");
  });
});

describe("report-generation compatibility contract", () => {
  it.each([undefined, null, "", "  ", "invalid-zone", 3, {}, []].map((zone) => ({ zone })))(
    "labels UTC explicitly for missing or malformed zone $zone", ({ zone }) => {
      expect(formatReportGeneratedAt("2000-02-02T22:00:00.000Z", zone))
        .toBe("الأربعاء 02/02/2000 · 10:00 مساءً (UTC)");
    },
  );

  it.each(["", "not-an-instant", "not-an-instantZ", "2000-02-02", "2000-02-02T22:00:00"])(
    "keeps invalid or timezone-less instant %j visibly unknown", (at) => {
      expect(formatReportGeneratedAt(at, "Asia/Aden")).toBe("—");
      expect(formatReportGeneratedAt(at)).toBe("—");
    },
  );

  it("accepts a valid explicit-offset instant without changing its meaning", () => {
    expect(formatReportGeneratedAt("2000-02-03T00:00:00+03:00", "Asia/Aden"))
      .toBe("الخميس 03/02/2000 · 12:00 صباحًا");
    expect(formatReportGeneratedAt("2000-02-03T00:00:00+03:00"))
      .toBe("الأربعاء 02/02/2000 · 9:00 مساءً (UTC)");
  });

  it.each([
    "2026-02-30T12:00:00Z", "2026-04-31T12:00:00Z",
    "2025-02-29T12:00:00Z", "1900-02-29T12:00:00Z",
    "2026-02-30T00:30:00+14:00", "2026-02-30T23:30:00-12:00",
  ])("does not normalize nonexistent calendar date in %s", (at) => {
    expect(formatReportGeneratedAt(at, "Asia/Aden")).toBe("—");
    expect(formatReportGeneratedAt(at)).toBe("—");
  });

  it("keeps real leap days and explicit offsets that cross UTC dates valid", () => {
    expect(formatReportGeneratedAt("2000-02-29T12:00:00Z", "Asia/Aden"))
      .toBe("الثلاثاء 29/02/2000 · 3:00 مساءً");
    expect(formatReportGeneratedAt("2026-03-01T00:30:00+14:00", "Asia/Aden"))
      .toBe("السبت 28/02/2026 · 1:30 مساءً");
  });
});

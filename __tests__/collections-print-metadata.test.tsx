import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrintableReportDocument } from "../components/reports/PrintableReportDocument";
import { SETTING_DEFAULTS } from "../lib/settings";
import type { ReportResult } from "../lib/reports-types";

describe("collections native print metadata", () => {
  it.each(["collections", "visits"] as const)("preserves %s metadata and shared identity without changing report evidence", report => {
    const result: ReportResult = { report, title: "تقرير اصطناعي", from: "2031-01-01", to: "2031-01-31",
      periodLabel: "فترة اصطناعية", filtersLabel: "مرشح اصطناعي", baseCurrency: "YER", kpis: [],
      columns: [{ key: "reference", label: "المرجع" }], rows: [{ reference: "SYNTHETIC-ROW" }], notes: ["SYNTHETIC-CLOSING-NOTE"] };
    const before = structuredClone(result);
    const html = renderToStaticMarkup(<PrintableReportDocument result={result} settings={SETTING_DEFAULTS}
      generatedAt="2031-01-31 10:00" generatedBy="SYNTHETIC-OPERATOR" />);
    expect(result).toEqual(before);
    expect(html).toContain('class="print-brand-header"');
    expect(html).toContain('class="print-table-frame');
    expect(html).toContain("SYNTHETIC-ROW");
    expect(html).toContain("SYNTHETIC-CLOSING-NOTE");
    expect(html).toContain("<div><strong>أُنشئ:</strong> 2031-01-31 10:00 · <strong>بواسطة:</strong> SYNTHETIC-OPERATOR</div>");
    if (report === "collections") {
      expect(html).toContain('<div class="report-meta">');
      expect(html).not.toContain('class="print-metadata');
      expect(html).toContain('<footer class="report-contact-footer">');
    } else {
      expect(html).toContain('class="print-metadata');
      expect(html).not.toContain('<div class="report-meta">');
    }
  });
});

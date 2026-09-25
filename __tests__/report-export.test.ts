import { describe, expect, it } from "vitest";
import { reportCsv, reportExcel } from "../lib/report-export";
import type { ReportColumn } from "../lib/reports-types";

const columns: ReportColumn[] = [{ key: "name", label: "الاسم" },
  { key: "amount", label: "المبلغ", type: "money", currencyKey: "currency" }];
const rows = [{ name: '=HYPERLINK("bad")', amount: 123456, currency: "USD" },
  { name: "علي, أحمد", amount: 123456, currency: "YER" }];

describe("report exports", () => {
  it("quotes grouping commas and preserves currencies without extra hidden columns", () => {
    const csv = reportCsv(columns, rows, "YER");
    expect(csv).toContain('"1,234.56 USD"');
    expect(csv).toContain('"123,456 YER"');
    expect(csv.split("\r\n")[0]).toBe('\uFEFF"الاسم","المبلغ"');
    expect(csv).toContain('"علي, أحمد"');
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
  });
  it("Excel keeps the selected order and currency when the currency column is hidden", () => {
    const xml = reportExcel([...columns].reverse(), rows, "YER");
    expect(xml.indexOf("المبلغ")).toBeLessThan(xml.indexOf("الاسم"));
    expect(xml).toContain("1,234.56 USD");
    expect(xml).toContain("123,456 YER");
    expect(xml).not.toContain("ss:Formula");
    expect(xml).toContain("&quot;bad&quot;");
  });
});

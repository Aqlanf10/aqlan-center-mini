import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DailyClinicReportBody } from "../app/reports/daily-clinic/DailyClinicReportView";
import { ReportView } from "../components/reports/ReportView";
import { DataTable, moneyText } from "../components/reports/shared";
import { SettingsProvider } from "../components/SettingsProvider";
import { EMPTY_REPORT_VIEW } from "../lib/report-view";
import type { ReportColumn, ReportResult, ReportRow } from "../lib/reports-types";
import { dailyClinicReportFixture } from "./fixtures/daily-clinic-report";

const identity = {
  "clinic.name": "مركز اصطناعي لاختبار المطبوعات",
  "clinic.lead_doctor": "طبيب اصطناعي",
  "clinic.lead_doctor_title": "تخصص اصطناعي",
  "clinic.lead_doctor_credentials": "مؤهل اصطناعي",
  "clinic.address": "عنوان اصطناعي",
  "clinic.phone": "SYNTHETIC-000",
};

describe("shared report print presentation preserves source evidence", () => {
  it.each(["summary", "full"] as const)("keeps day-close %s scope, all rows, columns and native monetary evidence", (printScope) => {
    const report = dailyClinicReportFixture("2031-01-15", 40);
    const before = structuredClone(report);
    const html = renderToStaticMarkup(<SettingsProvider value={identity}>
      <DailyClinicReportBody report={report} clinicName={identity["clinic.name"]} printScope={printScope} />
    </SettingsProvider>);
    expect(report).toEqual(before);
    expect(html).toContain('print-document-on-print');
    expect(html).toContain(`data-print-scope="${printScope}"`);
    expect(html).toContain('print-brand-header');
    expect(html).toContain(identity["clinic.lead_doctor_credentials"]);
    expect(html).toContain('print-metadata-on-print');
    expect(html.match(/<table(?:\s|>)/g)?.length).toBe(html.match(/class="print-table-watermark"/g)?.length);
    // The print adapter must be the existing focusable scroll region, not an
    // extra display:contents node between the region and its financial table.
    expect(html).toMatch(/<div[^>]*tabindex="0"[^>]*role="region"[^>]*class="[^"]*print-table-screen-frame/);
    expect(html).not.toMatch(/role="region"[^>]*><div class="print-table-frame/);
    expect(html.match(/data-patient-key=/g)).toHaveLength(report.attendees.length);
    for (const row of report.attendees) {
      expect(html).toContain(`data-patient-key="${row.key}"`);
      expect(html).toContain(row.patientNumber!);
      for (const currency of ["YER", "SAR", "USD"] as const) {
        expect(html).toContain(`data-minor="${row.agreement[currency]}" data-currency="${currency}"`);
        expect(html).toContain(`data-minor="${row.explicitlySettled[currency]}" data-currency="${currency}"`);
        expect(html).toContain(`data-minor="${row.agreementRemaining[currency]}" data-currency="${currency}"`);
      }
    }
    for (const invoice of report.invoices) expect(html).toContain(`data-invoice-id="${invoice.id}"`);
    expect(html.match(/data-testid="daily-clinic-attendee-totals"/g)).toHaveLength(1);
    expect(html.indexOf('print-report-footer')).toBeGreaterThan(html.indexOf('data-testid="daily-clinic-end"'));
    expect(html).toContain(identity["clinic.phone"]);
  });

  it("wraps a report table without dropping columns, mixing currencies or duplicating its closing totals", () => {
    const columns: ReportColumn[] = [
      { key: "name", label: "اسم اصطناعي طويل", type: "text" },
      { key: "currency", label: "العملة", type: "text" },
      { key: "amount", label: "القيمة", type: "money", currencyKey: "currency" },
    ];
    const rows: ReportRow[] = [
      { name: "اسم عربي اصطناعي طويل جدًا يلتف بلا حذف", currency: "YER", amount: 7654321 },
      { name: "SYNTHETIC-LONG-IDENTIFIER-000000000000000000000000000000000", currency: "SAR", amount: 23456 },
      { name: "سطر اصطناعي ثالث", currency: "USD", amount: -1234 },
    ];
    const before = structuredClone({ columns, rows });
    const html = renderToStaticMarkup(<DataTable columns={columns} rows={rows} base="YER" />);
    expect({ columns, rows }).toEqual(before);
    expect(html.match(/<th\s/g)).toHaveLength(columns.length);
    expect(html.match(/class="print-table-watermark"/g)).toHaveLength(1);
    expect(html).toMatch(/class="print-table-frame print-table-frame-on-print print-table-screen-frame overflow-x-auto /);
    expect(html.match(/<tfoot>/g)).toHaveLength(1);
    for (const row of rows) expect(html).toContain(String(row.name));
    for (const [amount, currency] of [[7654321, "YER"], [23456, "SAR"], [-1234, "USD"]] as const) {
      expect(html).toContain(moneyText(amount, currency));
    }
  });

  it("keeps report-center attribution in its semantic print footer after the table", () => {
    const result: ReportResult = { report: "daily", title: "تقرير اصطناعي", from: "2031-01-01", to: "2031-01-01", periodLabel: "فترة اصطناعية", filtersLabel: "مرشح اصطناعي", baseCurrency: "YER", kpis: [], columns: [{ key: "reference", label: "المرجع", type: "text" }], rows: [{ reference: "SYNTHETIC-REPORT-LAST-ROW" }] };
    const html = renderToStaticMarkup(<SettingsProvider value={identity}><ReportView result={result} clinicName={identity["clinic.name"]}
      generated={{ at: "2031-01-01T08:00:00Z", by: "مستخدم اصطناعي", clinicTimeZone: "Asia/Aden" }} printHref="/print/report?report=daily" view={EMPTY_REPORT_VIEW}
      onViewChange={() => {}} onPatientClick={() => {}} /></SettingsProvider>);
    expect(html).toContain('print-document-on-print');
    expect(html.indexOf('print-report-footer')).toBeGreaterThan(html.indexOf('SYNTHETIC-REPORT-LAST-ROW'));
    expect(html).toContain('<footer class="report-print-footer hidden print:block">');
    expect(html.indexOf('report-print-footer')).toBeGreaterThan(html.indexOf('SYNTHETIC-REPORT-LAST-ROW'));
    expect(html.slice(html.indexOf('report-print-footer'))).toContain("بواسطة مستخدم اصطناعي");
    expect(html).not.toContain('position: fixed');
    expect(html).toContain(result.filtersLabel);
  });

  it("keeps repeated table headings and single closing totals without a page-fit constraint", () => {
    const css = readFileSync(new URL("../components/print-document.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.print-table-frame > table > thead\s*\{\s*display: table-header-group/);
    expect(css).toMatch(/\.print-table-frame > table > tfoot\s*\{\s*display: table-row-group/);
    expect(css).toMatch(/\.print-table-frame\s*\{[^}]*break-inside: auto/);
  });
});

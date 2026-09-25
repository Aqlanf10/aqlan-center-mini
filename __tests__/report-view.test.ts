import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyReportView,
  EMPTY_REPORT_VIEW,
  parseReportView,
  writeReportView,
} from "../lib/report-view";
import { reportCsv } from "../lib/report-export";
import { formatAmount } from "../lib/money";
import { UNIFIED_REPORT_IDS, canAccessUnifiedReport } from "../lib/report-access";
import { REPORT_TEMPLATES, templatesForRole } from "../lib/report-templates";
import { normalizeSavedReportQuery } from "../lib/saved-reports";
import type { ReportColumn, ReportRow } from "../lib/reports-types";

const columns: ReportColumn[] = [
  { key: "patientName", label: "المريض" },
  { key: "doctorName", label: "الطبيب" },
  { key: "currency", label: "العملة" },
  { key: "amountMinor", label: "المبلغ", type: "money", currencyKey: "currency" },
  { key: "visits", label: "الزيارات", type: "count" },
];
const rows: ReportRow[] = [
  { patientName: "أ", doctorName: "د. سالم", currency: "YER", amountMinor: 5000, visits: 2 },
  { patientName: "ب", doctorName: "د. علي", currency: "USD", amountMinor: 1500, visits: 1 },
  { patientName: "ج", doctorName: "د. سالم", currency: "USD", amountMinor: 700, visits: 3 },
  { patientName: "د", doctorName: "د. سالم", currency: "YER", amountMinor: 2500, visits: null },
];

describe("report view spec (URL)", () => {
  it("round-trips columns order, sort and group", () => {
    const params = writeReportView(new URLSearchParams("report=x"), {
      columns: ["amountMinor", "patientName"],
      sort: { key: "amountMinor", direction: "asc" },
      group: "doctorName",
    });
    expect(params.get("columns")).toBe("amountMinor,patientName");
    expect(parseReportView(params)).toEqual({
      columns: ["amountMinor", "patientName"],
      sort: { key: "amountMinor", direction: "asc" },
      group: "doctorName",
    });
  });

  it("drops malformed keys instead of trusting the URL", () => {
    const view = parseReportView(new URLSearchParams("columns=a,,<script>,b&sort=x;drop:up&group=1bad"));
    expect(view.columns).toEqual(["a", "b"]);
    expect(view.sort).toBeNull();
    expect(view.group).toBeNull();
  });
});

describe("applyReportView — one view for screen, print and export", () => {
  it("shows the chosen columns in the chosen order and ignores unknown keys", () => {
    const applied = applyReportView(columns, rows, { ...EMPTY_REPORT_VIEW, columns: ["amountMinor", "ghost", "patientName"] }, "YER");
    expect(applied.columns.map((column) => column.key)).toEqual(["amountMinor", "patientName"]);
    expect(applied.view.columns).toEqual(["amountMinor", "patientName"]);
  });

  it("falls back to every column when nothing valid was chosen", () => {
    const applied = applyReportView(columns, rows, { ...EMPTY_REPORT_VIEW, columns: ["ghost"] }, "YER");
    expect(applied.columns).toBe(columns);
    expect(applied.view.columns).toBeNull();
  });

  it("sorts stably and keeps empty cells last in both directions", () => {
    const asc = applyReportView(columns, rows, { ...EMPTY_REPORT_VIEW, sort: { key: "visits", direction: "asc" } }, "YER");
    expect(asc.rows.map((row) => row.patientName)).toEqual(["ب", "أ", "ج", "د"]);
    const desc = applyReportView(columns, rows, { ...EMPTY_REPORT_VIEW, sort: { key: "visits", direction: "desc" } }, "YER");
    expect(desc.rows.map((row) => row.patientName)).toEqual(["ج", "أ", "ب", "د"]);
  });

  it("groups rows with per-currency subtotals — never one mixed total", () => {
    const applied = applyReportView(columns, rows, { ...EMPTY_REPORT_VIEW, group: "doctorName" }, "YER");
    const salem = applied.groups?.find((group) => group.label === "د. سالم");
    expect(salem?.rows).toHaveLength(3);
    expect(salem?.totals.amountMinor).toEqual({ YER: 7500, USD: 700 });
    const ali = applied.groups?.find((group) => group.label === "د. علي");
    expect(ali?.totals.amountMinor).toEqual({ USD: 1500 });
    // الصفوف المصدَّرة/المطبوعة متجاورة حسب المجموعة.
    expect(applied.rows.map((row) => row.doctorName)).toEqual(["د. سالم", "د. سالم", "د. سالم", "د. علي"]);
  });

  it("refuses to group on a money column", () => {
    const applied = applyReportView(columns, rows, { ...EMPTY_REPORT_VIEW, group: "amountMinor" }, "YER");
    expect(applied.groups).toBeNull();
    expect(applied.view.group).toBeNull();
  });

  it("the CSV export carries exactly the visible columns in the visible order", () => {
    const applied = applyReportView(columns, rows, { columns: ["amountMinor", "patientName"], sort: { key: "patientName", direction: "asc" }, group: null }, "YER");
    const csv = reportCsv(applied.columns, applied.rows, "YER");
    const [header, first] = csv.replace("﻿", "").split("\r\n");
    expect(header).toBe('"المبلغ","المريض"');
    expect(first).toBe(`"${formatAmount(5000, "YER")} YER","أ"`);
  });
});

describe("report allowlist stays in step with the engine", () => {
  it("every buildReport case is in the allowlist and vice versa", () => {
    const source = readFileSync("lib/reports.ts", "utf8");
    const start = source.indexOf("export async function buildReport(");
    const end = source.indexOf('default: throw new ReportInputError("نوع تقرير غير معروف.")', start);
    const cases = [...source.slice(start, end).matchAll(/case "([a-z-]+)":/g)].map((match) => match[1]);
    expect(new Set(cases)).toEqual(new Set(UNIFIED_REPORT_IDS));
  });
});

describe("ready-made templates", () => {
  it("are valid saved-report links and never offered beyond the role's access", () => {
    for (const template of REPORT_TEMPLATES) {
      const normalized = normalizeSavedReportQuery(template.reportId, template.queryString);
      expect(normalized.reportId).toBe(template.reportId);
    }
    for (const role of ["admin", "reception", "doctor", "accountant", null]) {
      for (const template of templatesForRole(role)) {
        expect(canAccessUnifiedReport(role, template.reportId)).toBe(true);
      }
    }
    expect(templatesForRole("doctor")).toEqual([]);
    expect(templatesForRole("reception").map((template) => template.reportId).sort()).toEqual(["appointments", "visits"]);
  });
});

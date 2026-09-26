import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { CURRENCIES, formatMoney, isCurrency, type Currency } from "@/lib/money";
import type { ReportColumn, ReportResult, ReportRow } from "@/lib/reports-types";
import type { SettingsMap } from "@/lib/settings";
import { applyReportView, EMPTY_REPORT_VIEW, type ReportGroup, type ReportViewSpec } from "@/lib/report-view";

/**
 * (P2-14) سطور التوقيع للتقارير التي تُسلَّم كتسوية: كشف عمولة الطبيب يوقّعه
 * الطبيب والمحاسب والمدير — فتصير الورقة مخالصةً لا مجرد جدول.
 */
const SIGNATURE_LINES: Record<string, readonly string[]> = {
  "doctor-commission": ["توقيع الطبيب", "المحاسب", "المدير"],
};

function rowCurrency(row: ReportRow, key: string | undefined, base: Currency): Currency {
  if (!key) return base;
  const value = row[key];
  return typeof value === "string" && isCurrency(value) ? value : base;
}

function cellText(row: ReportRow, column: ReportColumn, base: Currency): string {
  const value = row[column.key];
  if (value === null || value === undefined || value === "") return "—";
  if (column.type === "money") {
    return formatMoney(Number(value), rowCurrency(row, column.currencyKey, base));
  }
  if (column.type === "percent") return `${Number(value)}٪`;
  return String(value);
}

function moneyTotals(rows: ReportRow[], column: ReportColumn, base: Currency): string {
  const totals = new Map<Currency, number>();
  for (const row of rows) {
    const currency = rowCurrency(row, column.currencyKey, base);
    totals.set(currency, (totals.get(currency) ?? 0) + Number(row[column.key] ?? 0));
  }
  const used = CURRENCIES.filter((currency) => totals.has(currency));
  return used.length > 0
    ? used.map((currency) => formatMoney(totals.get(currency) ?? 0, currency)).join(" · ")
    : formatMoney(0, base);
}

function groupTotalText(group: ReportGroup, column: ReportColumn, base: Currency): string {
  const totals = group.totals[column.key] ?? {};
  const used = CURRENCIES.filter((currency) => totals[currency] !== undefined);
  return used.length > 0
    ? used.map((currency) => formatMoney(totals[currency] ?? 0, currency)).join(" · ")
    : formatMoney(0, base);
}

function ReportTable({ title, columns, rows, base, groups }: {
  title?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  base: Currency;
  groups?: ReportGroup[] | null;
}) {
  const hasMoney = columns.some((column) => column.type === "money");
  return (
    <section className="report-section">
      {title ? <h2 className="report-section-title">{title}</h2> : null}
      <table className="items report-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column.key}>{column.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="report-empty">لا توجد بيانات في هذه الفترة.</td></tr>
          ) : groups ? groups.map((group) => [
            <tr key={`g-${group.label}`} className="report-group-row">
              <td colSpan={columns.length}>{group.label} ({group.rows.length})</td>
            </tr>,
            ...group.rows.map((row, index) => (
              <tr key={`g-${group.label}-${index}`}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={column.type === "money" || column.type === "count" || column.type === "percent" ? "num" : undefined}
                  >
                    {cellText(row, column, base)}
                  </td>
                ))}
              </tr>
            )),
            ...(hasMoney ? [
              <tr key={`g-${group.label}-total`} className="report-subtotal-row">
                <td>مجموع {group.label}</td>
                {columns.slice(1).map((column) => (
                  <td key={column.key} className={column.type === "money" ? "num" : undefined}>
                    {column.type === "money" ? groupTotalText(group, column, base) : ""}
                  </td>
                ))}
              </tr>,
            ] : []),
          ]) : rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={column.type === "money" || column.type === "count" || column.type === "percent" ? "num" : undefined}
                >
                  {cellText(row, column, base)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {hasMoney && rows.length > 0 ? (
          <tfoot>
            <tr className="report-total-row">
              <td>الإجمالي ({rows.length} صفًا)</td>
              {columns.slice(1).map((column) => (
                <td key={column.key} className={column.type === "money" ? "num" : undefined}>
                  {column.type === "money" ? moneyTotals(rows, column, base) : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </section>
  );
}

export function PrintableReportDocument({
  result,
  settings,
  generatedAt,
  generatedBy,
  view = EMPTY_REPORT_VIEW,
}: {
  result: ReportResult;
  settings: SettingsMap;
  generatedAt: string;
  generatedBy: string;
  view?: ReportViewSpec;
}) {
  // (Reports R3) نفس طبقة العرض التي تخدم الشاشة والتصدير — لا حساب هنا.
  const applied = result.columns
    ? applyReportView(result.columns, result.rows ?? [], view, result.baseCurrency)
    : null;
  const detailColumns = applied?.columns ?? result.columns;
  const landscape = Math.max(detailColumns?.length ?? 0, result.monthly?.columns.length ?? 0) >= 8;

  return (
    <>
      <style>{`@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 8mm; }`}</style>
      <div className={`sheet sheet-report ${landscape ? "sheet-report-landscape" : ""}`}>
        <PrintHeader settings={settings} title={result.title} />

        <div className="report-meta">
          <div><strong>الفترة:</strong> {result.periodLabel}</div>
          <div><strong>الفلاتر:</strong> {result.filtersLabel || "بدون فلاتر إضافية"}</div>
          <div><strong>أُنشئ:</strong> {generatedAt} · <strong>بواسطة:</strong> {generatedBy}</div>
          <div><strong>العملة الأساسية:</strong> {result.baseCurrency}</div>
        </div>

        {result.subtitle ? <p className="report-subtitle">{result.subtitle}</p> : null}

        <section className="report-kpis" aria-label="المؤشرات">
          {result.kpis.map((kpi) => (
            <div className="report-kpi" key={kpi.key}>
              <span>{kpi.label}</span>
              <strong>
                {kpi.minor !== undefined
                  ? formatMoney(kpi.minor, kpi.currency ?? result.baseCurrency)
                  : kpi.count !== undefined
                    ? String(kpi.count)
                    : kpi.text ?? "—"}
              </strong>
              {kpi.hint ? <small>{kpi.hint}</small> : null}
            </div>
          ))}
        </section>

        {result.comparison ? (
          <section className="report-section">
            <h2 className="report-section-title">{result.comparison.title}</h2>
            <table className="items report-table">
              <thead>
                <tr><th>المؤشر</th><th>الحالي</th><th>السابق</th><th>التغير</th></tr>
              </thead>
              <tbody>
                {result.comparison.entries.map((entry) => {
                  const currency = entry.currency ?? result.baseCurrency;
                  return (
                    <tr key={entry.label}>
                      <td>{entry.label}</td>
                      <td className="num">{entry.count ? String(entry.currentMinor) : formatMoney(entry.currentMinor, currency)}</td>
                      <td className="num">{entry.count ? String(entry.previousMinor) : formatMoney(entry.previousMinor, currency)}</td>
                      <td className="num">{entry.changePercent === null ? "جديد" : `${entry.changePercent > 0 ? "+" : ""}${entry.changePercent}٪`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ) : null}

        {result.bars && result.bars.length > 0 ? (
          <section className="report-section">
            <h2 className="report-section-title">الاتجاه</h2>
            <table className="items report-table report-bars-table">
              <tbody>
                {result.bars.map((bar) => (
                  <tr key={bar.label}>
                    <td>{bar.label}</td>
                    <td className="num">{formatMoney(bar.minor, result.baseCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        {result.monthly && result.monthly.rows.length > 0 ? (
          <ReportTable
            title="التفصيل الشهري"
            columns={result.monthly.columns}
            rows={result.monthly.rows}
            base={result.baseCurrency}
          />
        ) : null}

        {result.rows && detailColumns ? (
          <ReportTable
            title={result.monthly ? "التفاصيل" : undefined}
            columns={detailColumns}
            rows={applied?.rows ?? result.rows}
            base={result.baseCurrency}
            groups={applied?.groups ?? null}
          />
        ) : null}

        {(result.sections ?? []).filter((section) => section.rows.length > 0).map((section) => (
          <ReportTable key={section.title} title={section.title} columns={section.columns} rows={section.rows} base={result.baseCurrency} />
        ))}

        {result.notes && result.notes.length > 0 ? (
          <section className="report-notes">
            <strong>ملاحظات وقراءة الأرقام</strong>
            <ul>
              {result.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </section>
        ) : null}

        {SIGNATURE_LINES[result.report] ? (
          <div className="sign-row">
            {SIGNATURE_LINES[result.report].map((label) => (
              <span key={label}>{label}: ................</span>
            ))}
          </div>
        ) : null}

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}

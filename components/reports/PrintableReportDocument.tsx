import { PrintFooter, PrintHeader } from "@/components/PrintHeader";
import { CURRENCIES, formatMoney, isCurrency, type Currency } from "@/lib/money";
import type { ReportColumn, ReportResult, ReportRow } from "@/lib/reports-types";
import type { SettingsMap } from "@/lib/settings";

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

function ReportTable({ title, columns, rows, base }: {
  title?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  base: Currency;
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
          ) : rows.map((row, index) => (
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
}: {
  result: ReportResult;
  settings: SettingsMap;
  generatedAt: string;
  generatedBy: string;
}) {
  const landscape = Math.max(result.columns?.length ?? 0, result.monthly?.columns.length ?? 0) >= 8;

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
                      <td className="num">{formatMoney(entry.currentMinor, currency)}</td>
                      <td className="num">{formatMoney(entry.previousMinor, currency)}</td>
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

        {result.rows && result.columns ? (
          <ReportTable
            title={result.monthly ? "التفاصيل" : undefined}
            columns={result.columns}
            rows={result.rows}
            base={result.baseCurrency}
          />
        ) : null}

        {result.notes && result.notes.length > 0 ? (
          <section className="report-notes">
            <strong>ملاحظات وقراءة الأرقام</strong>
            <ul>
              {result.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          </section>
        ) : null}

        <PrintFooter settings={settings} />
      </div>
    </>
  );
}

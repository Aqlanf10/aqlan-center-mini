import { formatAmount, isCurrency, type Currency } from "./money";
import type { ReportColumn, ReportRow } from "./reports-types";

/** Keep the selected columns intact; the currency travels inside each money cell. */
function cellValue(row: ReportRow, column: ReportColumn, base: Currency): string {
  const value = row[column.key];
  if (value == null) return "";
  if (column.type !== "money") return String(value);
  const raw = column.currencyKey ? row[column.currencyKey] : base;
  const currency = isCurrency(raw) ? raw : base;
  return `${formatAmount(Number(value), currency)} ${currency}`;
}

export function reportCsv(columns: ReportColumn[], rows: ReportRow[], base: Currency): string {
  const quote = (text: string) => {
    // Quoting alone does not stop a spreadsheet evaluating an untrusted formula.
    const safe = /^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return "\uFEFF" + [
    columns.map((column) => quote(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => quote(cellValue(row, column, base))).join(",")),
  ].join("\r\n");
}

export function reportExcel(columns: ReportColumn[], rows: ReportRow[], base: Currency): string {
  const xml = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const cell = (text: string) => `<Cell><Data ss:Type="String">${xml(text)}</Data></Cell>`;
  const header = `<Row>${columns.map((column) => cell(column.label)).join("")}</Row>`;
  const body = rows.map((row) => `<Row>${columns.map((column) => cell(cellValue(row, column, base))).join("")}</Row>`).join("");
  return `\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="Report"><Table>${header}${body}</Table>
<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><DisplayRightToLeft/></WorksheetOptions>
</Worksheet></Workbook>`;
}

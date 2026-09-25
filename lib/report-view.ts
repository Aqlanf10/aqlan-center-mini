/**
 * (Reports R3) عرض التقرير المخصَّص: أعمدةٌ مختارة بترتيبها، ترتيب صفوف، وتجميع.
 *
 * طبقة عرضٍ خالصة فوق `ReportResult` — لا تعيد حساب أي رقم. الشاشة والطباعة
 * الرسمية وExcel وCSV كلها تمرّ بهذه الدالة نفسها، فما يراه المستخدم هو ما يُطبع
 * ويُصدَّر حرفيًّا. والمجاميع داخل المجموعة لكل عملة على حدة (لا جمع عبر العملات).
 */

import { CURRENCIES, isCurrency, type Currency } from "./money";
import type { ReportColumn, ReportRow } from "./reports-types";

export type ReportSortDirection = "asc" | "desc";

export interface ReportViewSpec {
  /** مفاتيح الأعمدة الظاهرة بترتيب عرضها — `null` = أعمدة التقرير كلها بترتيبه. */
  columns: string[] | null;
  sort: { key: string; direction: ReportSortDirection } | null;
  /** مفتاح عمود التجميع — `null` = بلا تجميع. */
  group: string | null;
}

export const EMPTY_REPORT_VIEW: ReportViewSpec = { columns: null, sort: null, group: null };

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_COLUMNS = 40;

function cleanKey(value: string): string | null {
  const key = value.trim();
  return KEY_PATTERN.test(key) ? key : null;
}

/** يقرأ مواصفة العرض من معاملات الرابط (`columns`، `sort`، `group`) — والمدخل الفاسد يُهمل. */
export function parseReportView(params: URLSearchParams): ReportViewSpec {
  const columns = [...new Set(
    (params.get("columns") ?? "").split(",").map(cleanKey).filter((key): key is string => key !== null),
  )].slice(0, MAX_COLUMNS);

  let sort: ReportViewSpec["sort"] = null;
  const rawSort = params.get("sort");
  if (rawSort) {
    const [rawKey, rawDirection] = rawSort.split(":");
    const key = cleanKey(rawKey ?? "");
    if (key) sort = { key, direction: rawDirection === "asc" ? "asc" : "desc" };
  }

  const group = cleanKey(params.get("group") ?? "");
  return { columns: columns.length > 0 ? columns : null, sort, group };
}

/** يكتب مواصفة العرض في معاملات الرابط (ويحذف الفارغ منها). */
export function writeReportView(params: URLSearchParams, view: ReportViewSpec): URLSearchParams {
  if (view.columns && view.columns.length > 0) params.set("columns", view.columns.join(","));
  else params.delete("columns");
  if (view.sort) params.set("sort", `${view.sort.key}:${view.sort.direction}`);
  else params.delete("sort");
  if (view.group) params.set("group", view.group);
  else params.delete("group");
  return params;
}

/** الأعمدة الظاهرة بترتيب المستخدم — المفاتيح المجهولة تُهمل، والفراغ يعود لأعمدة التقرير كلها. */
export function resolveColumns(available: ReportColumn[], requested: string[] | null): ReportColumn[] {
  if (!requested || requested.length === 0) return available;
  const byKey = new Map(available.map((column) => [column.key, column]));
  const picked = requested.map((key) => byKey.get(key)).filter((column): column is ReportColumn => Boolean(column));
  return picked.length > 0 ? picked : available;
}

function compareCells(a: ReportRow[string], b: ReportRow[string]): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const an = typeof a === "number" ? a : Number(a);
  const bn = typeof b === "number" ? b : Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  return String(a).localeCompare(String(b), "ar");
}

/** ترتيب مستقر: الصفوف المتساوية تبقى بترتيب التقرير الأصلي. */
export function sortRows(rows: ReportRow[], sort: ReportViewSpec["sort"]): ReportRow[] {
  if (!sort) return rows;
  const sign = sort.direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const cmp = compareCells(a.row[sort.key], b.row[sort.key]);
      // الفارغ في الآخر دائمًا، أيًّا كان الاتجاه.
      const aEmpty = a.row[sort.key] == null || a.row[sort.key] === "";
      const bEmpty = b.row[sort.key] == null || b.row[sort.key] === "";
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      return cmp !== 0 ? cmp * sign : a.index - b.index;
    })
    .map((item) => item.row);
}

export interface ReportGroup {
  label: string;
  rows: ReportRow[];
  /** مجموع كل عمود مال داخل المجموعة — لكل عملة على حدة. */
  totals: Record<string, Partial<Record<Currency, number>>>;
}

function rowCurrency(row: ReportRow, key: string | undefined, base: Currency): Currency {
  if (!key) return base;
  const value = row[key];
  return typeof value === "string" && isCurrency(value) ? value : base;
}

/** مجموع عمود مالٍ لكل عملة — لا رقمٌ واحد يمزج الدلاء. */
export function moneyTotalsByCurrency(
  rows: ReportRow[],
  column: ReportColumn,
  base: Currency,
): Partial<Record<Currency, number>> {
  const totals: Partial<Record<Currency, number>> = {};
  for (const row of rows) {
    const currency = rowCurrency(row, column.currencyKey, base);
    totals[currency] = (totals[currency] ?? 0) + Number(row[column.key] ?? 0);
  }
  const ordered: Partial<Record<Currency, number>> = {};
  for (const currency of CURRENCIES) if (totals[currency] !== undefined) ordered[currency] = totals[currency];
  return ordered;
}

export interface AppliedReportView {
  columns: ReportColumn[];
  rows: ReportRow[];
  /** المجموعات بترتيب ظهورها — `null` حين لا تجميع. */
  groups: ReportGroup[] | null;
  /** المواصفة بعد تنقيتها على أعمدة هذا التقرير (ما يُحفظ في الرابط). */
  view: ReportViewSpec;
}

/**
 * يطبّق مواصفة العرض على أعمدة وصفوف التقرير. يُتجاهل كل مفتاحٍ لا يوجد في
 * التقرير (رابط قديم أو معدَّل يدويًّا) ولا يُكسر العرض. عمود المال لا يُجمَّع عليه.
 */
export function applyReportView(
  available: ReportColumn[],
  rows: ReportRow[],
  spec: ReportViewSpec,
  base: Currency,
): AppliedReportView {
  const keys = new Set(available.map((column) => column.key));
  const columns = resolveColumns(available, spec.columns);
  const sort = spec.sort && keys.has(spec.sort.key) ? spec.sort : null;
  const groupColumn = spec.group ? available.find((column) => column.key === spec.group) : undefined;
  const group = groupColumn && groupColumn.type !== "money" ? groupColumn.key : null;
  const sorted = sortRows(rows, sort);

  const cleanColumns = spec.columns && columns !== available ? columns.map((column) => column.key) : null;
  const view: ReportViewSpec = { columns: cleanColumns, sort, group };

  if (!group) return { columns, rows: sorted, groups: null, view };

  const moneyColumns = columns.filter((column) => column.type === "money");
  const byLabel = new Map<string, ReportRow[]>();
  for (const row of sorted) {
    const raw = row[group];
    const label = raw === null || raw === undefined || raw === "" ? "—" : String(raw);
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(row);
    else byLabel.set(label, [row]);
  }
  const groups: ReportGroup[] = [...byLabel.entries()]
    .sort(([a], [b]) => (a === "—" ? 1 : b === "—" ? -1 : a.localeCompare(b, "ar")))
    .map(([label, groupRows]) => ({
      label,
      rows: groupRows,
      totals: Object.fromEntries(moneyColumns.map((column) => [column.key, moneyTotalsByCurrency(groupRows, column, base)])),
    }));
  return { columns, rows: groups.flatMap((item) => item.rows), groups, view };
}

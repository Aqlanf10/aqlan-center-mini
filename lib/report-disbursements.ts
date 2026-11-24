import { createHash } from "node:crypto";
import { BANK_ACCOUNT, CASH_ACCOUNT, CURRENCY_CLEARING_ACCOUNT } from "./accounting";
import { onClinicDaysSql } from "./clinic-day-sql";
import { loadClinicExpenseRangeReport, type ClinicExpenseRangeReport, type DailyClinicExpenseMovement, type DailyClinicExpenseQueryRunner } from "./daily-clinic-expense-report";
import { CLINIC_BASE_CURRENCY, CURRENCIES, isCurrency, type Currency } from "./money";
import type { KpiItem, ReportFilters, ReportResult, ReportRow } from "./reports-types";

import type { DisbursementReportId } from "./report-access";

const columns = [
  { key: "day", label: "تاريخ الحركة" }, { key: "time", label: "الوقت" },
  { key: "reference", label: "رقم المستند" }, { key: "movement", label: "نوع الحركة" },
  { key: "recipient", label: "المستفيد المسجّل" }, { key: "category", label: "البند" },
  { key: "channel", label: "القناة المسجّلة" }, { key: "currency", label: "العملة" },
  { key: "amount", label: "المبلغ بعملة الحركة", type: "money", currencyKey: "currency", stackCurrencyTotals: true },
] satisfies NonNullable<ReportResult["columns"]>;
const voucherTypes: Record<DailyClinicExpenseMovement["kind"], string> = {
  outflow: "سند صرف", reversal: "عكس سند صرف",
  negative_adjustment: "تعديل مصروف سالب غير مرتبط", zero: "سند بقيمة صفر",
};
type CashRow = ReportRow & { currency: Currency; amount: number; reference: string };
type DatedRow = { at: string; serial: number; row: CashRow };
type Voucher = ClinicExpenseRangeReport["movements"][number];
type Option = { value: string; label: string };
type FilterCurrency = ReportFilters["currency"];

const fail = (): never => { throw new Error("DISBURSEMENT_SOURCE_INVALID"); };
function integer(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+$/.test(value))) return fail();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fail();
}
const positive = (value: unknown) => { const n = integer(value); return n > 0 ? n : fail(); };
const savedCurrency = (value: unknown): Currency => isCurrency(value) ? value : fail();
const savedText = (value: unknown): string => typeof value === "string" && value.trim() ? value : fail();
const matchesCurrency = (selected: FilterCurrency, currency: Currency) => selected === "all" || selected === currency;

const digest = (scope: string, value: string) => createHash("sha256").update(scope + "\0" + value, "utf8").digest("hex");
function payee(row: Voucher): Option {
  const recipient = row.recipient;
  const display = recipient.partyId !== null
    ? (recipient.currentPartyName?.trim() || "اسم الجهة الحالي غير متاح") + " (#" + recipient.partyId + ")"
    : recipient.recordedPayeeText?.trim()
      ? recipient.recordedPayeeText.trim() + " (اسم مسجّل)" : "مستفيد غير مسجّل";
  return { value: digest("payee", recipient.key), label: display };
}
const category = (row: Voucher): Option => ({ value: digest("category", row.categoryGroupKey), label: row.categoryLabel });
function optionList(options: Option[]): Option[] {
  return [...new Map(options.map(option => [option.value, option])).values()]
    .sort((a, b) => a.label.localeCompare(b.label, "ar") || a.value.localeCompare(b.value));
}
function voucherRow(voucher: Voucher, recipient: Option, item: Option): DatedRow {
  const settlement = voucher.payableId !== null || voucher.allocations.length > 0
    ? "سداد التزام بسند صرف"
    : voucher.recipient.partyKind === "supplier" || voucher.recipient.partyKind === "lab" ? "سند صرف لجهة" : null;
  const recorded = voucher.recipient.recordedPayeeText?.trim();
  const recipientLabel = voucher.recipient.partyId !== null && recorded && recorded !== voucher.recipient.currentPartyName?.trim()
    ? recipient.label + " · كما سُجّل: " + recorded : recipient.label;
  return { at: voucher.createdAt, serial: voucher.id, row: {
    day: voucher.clinicDate, time: voucher.clinicTime, reference: voucher.voucherNumber,
    movement: voucher.kind === "outflow" && settlement ? settlement : voucherTypes[voucher.kind],
    recipient: recipientLabel, category: item.label, channel: "درج النقد",
    amount: voucher.amountMinor, currency: voucher.currency,
  } };
}
function addKpis(cards: KpiItem[], key: string, label: string, rows: CashRow[], selected: FilterCurrency, empty = false) {
  for (const currency of CURRENCIES) {
    const values = rows.filter(row => row.currency === currency);
    if (!matchesCurrency(selected, currency) || (!values.length && !empty)) continue;
    cards.push({ key: key + "-" + currency, label: label + " (" + currency + ")", currency,
      minor: values.reduce((sum, row) => integer(sum + row.amount), 0) });
  }
}

function expenseResult(expenses: ClinicExpenseRangeReport, filters: ReportFilters, base: ReportResult): ReportResult {
  const available = expenses.movements.map(voucher => ({ voucher, recipient: payee(voucher), item: category(voucher) }));
  const payees = optionList(available.map(entry => entry.recipient));
  const categories = optionList(available.map(entry => entry.item));
  const rows = available.filter(({ recipient, item }) =>
    (!filters.expenseRecipient || recipient.value === filters.expenseRecipient)
    && (!filters.expenseCategory || item.value === filters.expenseCategory))
    .map(({ voucher, recipient, item }) => voucherRow(voucher, recipient, item).row).reverse();
  addKpis(base.kpis, "posted", "سندات الصرف الموجبة", rows.filter(row => row.amount > 0), filters.currency);
  addKpis(base.kpis, "adjustments", "العكس والتصحيحات السالبة", rows.filter(row => row.amount < 0), filters.currency);
  addKpis(base.kpis, "net", "صافي سندات الصرف", rows, filters.currency, !rows.length);
  const label = (options: Option[], selected: string) =>
    options.find(option => option.value === selected)?.label ?? "الاختيار غير موجود في الفترة";
  return {
    ...base, title: "المصروفات حسب المستفيد والبند",
    subtitle: "سندات الصرف المسجّلة بعملتها الأصلية، لا مصروفات الاستحقاق.",
    columns: columns.filter(column => column.key !== "channel"), rows,
    expenseFilterOptions: { payees, categories },
    filtersLabel: [base.filtersLabel,
      filters.expenseRecipient ? "المستفيد: " + label(payees, filters.expenseRecipient) : "",
      filters.expenseCategory ? "البند: " + label(categories, filters.expenseCategory) : "",
    ].filter(Boolean).join(" · "),
    notes: [
      "الجهة المرتبطة تُعرف بمعرّفها؛ الاسم النصي كما سُجّل وليس إثباتًا لهوية واحدة. لا يُستنتج المستفيد من الملاحظات.",
      "سداد الالتزام لا يُضاف مرة أخرى ولا يثبت تكلفةً جديدة. السالب يظهر في تاريخ تسجيله.",
      "لا يضم الكشف ردود المرضى أو القيود اليدوية أو التحويلات الداخلية.",
    ],
  };
}

// Both predicates require the structured durable writer's evidence, not note text.
const refundSql = [
  "SELECT p.id, p.receipt_number AS reference, p.created_at AS at,",
  "(p.created_at AT TIME ZONE $1)::date::text AS day, to_char(p.created_at AT TIME ZONE $1, 'HH24:MI:SS') AS time,",
  "p.currency, p.amount_minor::text AS minor, p.method,",
  "EXISTS (SELECT 1 FROM audit_log a WHERE a.entity = 'payment' AND a.action = 'payment.refund'",
  "AND a.entity_id = p.id::text",
  "AND a.details->>'المريض' = p.patient_id::text AND a.details->>'المبلغ' = p.amount_minor::text",
  "AND a.details->>'العملة' = p.currency) AS refund_recorded,",
  "EXISTS (SELECT 1 FROM audit_log a JOIN payments original ON original.id = p.reversal_of_id",
  "AND original.patient_id = p.patient_id AND original.kind = 'payment'",
  "WHERE a.entity = 'payment' AND a.action = 'payment.correct' AND a.entity_id = original.id::text",
  "AND a.details->>'الطريقة' IN ('إبطال', 'تصحيح')",
  "AND a.details->>'سند_العكس' = p.receipt_number AND a.details->>'المريض' = p.patient_id::text",
  "AND a.details->>'المبلغ_المعكوس' = p.amount_minor::text AND a.details->>'العملة_المعكوسة' = p.currency) AS adjustment_recorded",
  "FROM payments p WHERE p.kind = 'refund' AND", onClinicDaysSql("p.created_at", "$1", "$2::date", "$3::date"),
  "ORDER BY p.created_at, p.id",
].join("\n");
type RefundSource = { id: unknown; reference: unknown; at: unknown; day: unknown; time: unknown; currency: unknown; minor: unknown;
  method: unknown; refund_recorded: unknown; adjustment_recorded: unknown };
type ManualSource = { id: unknown; day: unknown; lines: { code: unknown; currency: unknown; side: unknown; minor: unknown }[] };

function refundMovements(source: RefundSource[], selected: FilterCurrency) {
  const rows: DatedRow[] = [];
  const groups: Record<"cash" | "transfer" | "methodUnknown" | "adjustment" | "unproved", CashRow[]> =
    { cash: [], transfer: [], methodUnknown: [], adjustment: [], unproved: [] };
  for (const item of source) {
    const currency = savedCurrency(item.currency);
    if (!matchesCurrency(selected, currency)) continue;
    const at = item.at instanceof Date ? item.at : new Date(savedText(item.at));
    if (!Number.isFinite(at.getTime()) || typeof item.adjustment_recorded !== "boolean" || typeof item.refund_recorded !== "boolean") return fail();
    const route = item.method === "cash" ? "cash" : item.method === "transfer" ? "transfer" : "methodUnknown";
    const kind = item.adjustment_recorded === item.refund_recorded ? "unproved" : item.refund_recorded ? route : "adjustment";
    const row: CashRow = {
      day: savedText(item.day), time: savedText(item.time), reference: savedText(item.reference), currency, amount: positive(item.minor),
      movement: kind === "adjustment" ? "إبطال / تصحيح سند قبض"
        : kind === "unproved" ? "ردّ / عكس سند قبض، الغرض غير موثّق" : "ردّ مريض مسجّل",
      recipient: null, category: null,
      channel: route === "cash" ? "نقد" : route === "transfer" ? "حوالة" : "الوسيلة غير مثبتة",
    };
    groups[kind].push(row);
    rows.push({ at: at.toISOString(), serial: positive(item.id), row });
  }
  return { rows, groups };
}

const liquidity = new Map<string, { currency: Currency; channel: string }>();
for (const currency of CURRENCIES) {
  liquidity.set(CASH_ACCOUNT[currency], { currency, channel: "درج النقد" });
  liquidity.set(BANK_ACCOUNT[currency], { currency, channel: "البنك والحوالات" });
}

// One outgoing net leg per recorded account in a manual entry. Only balanced
// entries whose entire account set proves internal liquidity movement may be
// called transfers; unrelated manual credits are evidence but not expenses.
function manualMovements(source: ManualSource[], selected: FilterCurrency): DatedRow[] {
  return source.flatMap((item) => {
    const byAccount = new Map<string, { marker: { currency: Currency; channel: string }; currency: Currency; minor: number }>();
    const balances = new Map<Currency, number>();
    let onlyLiquidity = true;
    for (const line of item.lines) {
      const code = savedText(line.code), currency = savedCurrency(line.currency);
      if (line.side !== "credit" && line.side !== "debit") return fail();
      const delta = positive(line.minor) * (line.side === "credit" ? 1 : -1);
      const account = liquidity.get(code);
      if (!account) onlyLiquidity &&= code === CURRENCY_CLEARING_ACCOUNT;
      else {
        onlyLiquidity &&= account.currency === currency;
        const key = code + ":" + currency;
        byAccount.set(key, { marker: account, currency, minor: integer((byAccount.get(key)?.minor ?? 0) + delta) });
      }
      balances.set(currency, integer((balances.get(currency) ?? 0) + delta));
    }
    const internal = onlyLiquidity && [...byAccount.values()].some(value => value.minor < 0)
      && [...balances.values()].every(value => value === 0);
    const id = positive(item.id), day = savedText(item.day);
    return [...byAccount.values()].flatMap(({ marker, currency, minor }) => {
      if (minor <= 0 || !matchesCurrency(selected, currency)) return [];
      const accountMatches = marker.currency === currency;
      return [{ serial: id, at: day, row: {
        day, time: null, reference: "قيد #" + id, currency, amount: minor,
        channel: accountMatches ? marker.channel : "عملة الحساب غير مطابقة", recipient: null, category: null,
        movement: internal ? "قيد تحويل داخلي — ليس مصروفًا" : "قيد يدوي دائن — الغرض غير مثبت",
      } }];
    });
  });
}

export async function loadDisbursementReport(
  report: DisbursementReportId, filters: ReportFilters, timeZone: string, runner: DailyClinicExpenseQueryRunner,
): Promise<ReportResult> {
  const { from, to, currency } = filters;
  const expenses = await loadClinicExpenseRangeReport({ from, to, timeZone, currency }, runner);
  const base: ReportResult = { report, title: "حركة الخرج اليومية", from, to, periodLabel: from === to ? from : from + " ← " + to,
    baseCurrency: CLINIC_BASE_CURRENCY, kpis: [], filtersLabel: currency === "all" ? "كل العملات" : currency };
  if (report === "expense-payees") return expenseResult(expenses, filters, base);

  const refunds = refundMovements((await runner.query(refundSql, [timeZone, from, to])).rows as RefundSource[], currency);
  const manual = manualMovements((await runner.query([
    "SELECT m.id, m.entry_date::text AS day, jsonb_agg(jsonb_build_object(",
    "'code', l.account_code, 'currency', l.currency, 'side', l.side, 'minor', l.amount_minor::text) ORDER BY l.id) AS lines",
    "FROM journal_manual m JOIN journal_manual_lines l ON l.entry_id = m.id",
    "WHERE m.entry_date BETWEEN $1::date AND $2::date",
    "AND EXISTS (SELECT 1 FROM journal_manual_lines li WHERE li.entry_id = m.id AND li.account_code = ANY($3::text[]))",
    "GROUP BY m.id, m.entry_date",
  ].join("\n"), [from, to, [...liquidity.keys()]])).rows as ManualSource[], currency);
  const vouchers = expenses.movements.map(item => voucherRow(item, payee(item), category(item)));
  const rows = [...vouchers, ...refunds.rows, ...manual].sort((a, b) => b.at.localeCompare(a.at) || b.serial - a.serial).map(item => item.row);
  addKpis(base.kpis, "voucher", "صافي سندات الصرف", vouchers.map(item => item.row), currency);
  addKpis(base.kpis, "refund-cash", "ردود المرضى المسجّلة نقدًا", refunds.groups.cash, currency);
  addKpis(base.kpis, "refund-bank", "ردود المرضى المسجّلة بحوالة", refunds.groups.transfer, currency);
  addKpis(base.kpis, "refund-unknown", "ردود مرضى بوسيلة غير مثبتة", refunds.groups.methodUnknown, currency);
  addKpis(base.kpis, "void", "إبطالات وتصحيحات سندات القبض", refunds.groups.adjustment, currency);
  addKpis(base.kpis, "uncertain", "ردود أو عكس غير محدد", refunds.groups.unproved, currency);
  return {
    ...base, subtitle: "حركات الخرج المسجّلة للصندوق والبنك؛ ليست مطابقةً لسيولة فعلية.",
    columns: columns.map(column => column.key === "amount" ? { ...column, aggregate: "none" } : column), rows,
    notes: [
      "سند الصرف يظهر مرة واحدة؛ التسويات والتوزيعات ليست دفعات إضافية. السالب يخفض صافي السندات.",
      "الردّ الموثّق منفصل عن إبطال أو تصحيح سند قبض. السند غير المثبت يبقى «ردّ / عكس» ولا يُحسب ردًا نقديًا.",
      "التحويل الداخلي والقيود اليدوية تظهر للمراجعة دون إضافتها إلى المصروفات؛ لا يُستنتج الغرض من نص القيد.",
      "لا تُجمع هذه الأنواع في إجمالي واحد؛ القيد لا يثبت وحده تسليم النقد أو تسوية البنك.",
    ],
  };
}

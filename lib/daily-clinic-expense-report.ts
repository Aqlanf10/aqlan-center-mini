import { onClinicDaySql } from "./clinic-day-sql";
import { CURRENCIES, isCurrency, requireCurrency, type Currency } from "./money";

/** Recorded spending vouchers, not an accrual income statement or every cash-ledger entry. */
export interface DailyClinicExpenseQuery {
  date: string;
  timeZone: string;
  currency?: "all" | Currency;
}

/** The caller owns the read-only, repeatable-read snapshot. No pool/schema side effects here. */
export interface DailyClinicExpenseQueryRunner {
  query(sql: string, values: unknown[]): Promise<{ rows: unknown[] }>;
}

export type DailyClinicExpenseAmounts = Record<Currency, number>;
export interface NativeExpenseTotals {
  outflowMinor: DailyClinicExpenseAmounts;
  /** Absolute negative vouchers, including explicitly counted unlinked negative corrections. */
  reversalMinor: DailyClinicExpenseAmounts;
  netOutflowMinor: DailyClinicExpenseAmounts;
  voucherCount: number;
  reversalCount: number;
  negativeAdjustmentCount: number;
}

export interface DailyClinicExpenseRecipient {
  key: string;
  partyId: number | null;
  partyKind: string | null;
  currentPartyName: string | null;
  recordedPayeeText: string | null;
  displayName: string;
  nameSource: "current_party" | "recorded_text" | "missing";
}

export interface DailyClinicExpenseAllocation {
  payableId: number;
  sourceType: "operational" | "opening" | null;
  /** Signed native voucher currency; never add this to the parent voucher again. */
  paidMinor: number;
  payableCurrency: Currency;
  settledMinor: number;
}

export interface DailyClinicExpenseMovement {
  id: number;
  voucherNumber: string;
  createdAt: string;
  clinicDate: string;
  clinicTime: string;
  shiftId: number;
  categoryKey: string;
  categoryLabel: string;
  recipient: DailyClinicExpenseRecipient;
  amountMinor: number;
  currency: Currency;
  kind: "outflow" | "reversal" | "negative_adjustment" | "zero";
  reversalOfId: number | null;
  originalVoucherNumber: string | null;
  payableId: number | null;
  payableSourceType: "operational" | "opening" | null;
  allocations: DailyClinicExpenseAllocation[];
  /** Only a lab/supplier residual: null for direct vouchers and other party kinds. */
  unallocatedMinor: number | null;
  note: string | null;
  createdBy: string | null;
}

export interface DailyClinicRecipientTotals {
  recipient: DailyClinicExpenseRecipient;
  /** Different recorded names are retained; the first voucher is not a name authority. */
  recordedPayeeTexts: string[];
  totals: NativeExpenseTotals;
}

export interface DailyClinicExpenseReport {
  date: string;
  timeZone: string;
  scope: "clinic_spending_vouchers";
  currency: "all" | Currency;
  movements: DailyClinicExpenseMovement[];
  recipientTotals: DailyClinicRecipientTotals[];
  totals: NativeExpenseTotals;
  caveats: string[];
}

/** Raw database boundary; monetary strings are validated before conversion to JS numbers. */
export interface DailyClinicExpenseSourceRow {
  id: unknown;
  voucher_number: unknown;
  created_at: unknown;
  shift_id: unknown;
  category: unknown;
  category_name: unknown;
  party_id: unknown;
  party_name: unknown;
  party_kind: unknown;
  payee_text: unknown;
  amount_minor: unknown;
  currency: unknown;
  reversal_of_id: unknown;
  original_voucher_number: unknown;
  original_currency: unknown;
  payable_id: unknown;
  payable_source_type: unknown;
  payable_party_id: unknown;
  allocations: unknown;
  note: unknown;
  created_by: unknown;
}

export class DailyClinicExpenseIntegrityError extends Error {
  constructor() {
    // Do not put recipient names, notes or raw financial values in a public error.
    super("تعذّر اعتماد كشف سندات الصرف بسبب بيانات غير متسقة. يلزم فحص السجلات.");
    this.name = "DailyClinicExpenseIntegrityError";
  }
}

function reject(): never { throw new DailyClinicExpenseIntegrityError(); }

function integer(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^-?\d+$/.test(value))) reject();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) reject();
  return parsed;
}

function id(value: unknown): number {
  const parsed = integer(value);
  if (parsed <= 0) reject();
  return parsed;
}

function nullableId(value: unknown): number | null { return value == null ? null : id(value); }
function nullableText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") reject();
  return value;
}
function requiredText(value: unknown): string {
  const text = nullableText(value);
  if (text === null || text.trim() === "") reject();
  return text;
}
function sourceType(value: unknown): "operational" | "opening" | null {
  if (value == null) return null;
  if (value !== "operational" && value !== "opening") reject();
  return value;
}
function safeAdd(left: number, right: number): number { return integer(left + right); }

export function validateDailyClinicExpenseQuery(query: DailyClinicExpenseQuery): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date) || query.date.startsWith("0000")) reject();
  const date = new Date(`${query.date}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== query.date) reject();
  if (query.currency !== undefined && query.currency !== "all" && !isCurrency(query.currency)) reject();
  if (typeof query.timeZone !== "string" || !query.timeZone.trim()) reject();
  try { new Intl.DateTimeFormat("en-CA", { timeZone: query.timeZone }).format(date); }
  catch { reject(); }
}

function blankAmounts(): DailyClinicExpenseAmounts {
  return Object.fromEntries(CURRENCIES.map((currency) => [currency, 0])) as DailyClinicExpenseAmounts;
}
function blankTotals(): NativeExpenseTotals {
  return { outflowMinor: blankAmounts(), reversalMinor: blankAmounts(), netOutflowMinor: blankAmounts(),
    voucherCount: 0, reversalCount: 0, negativeAdjustmentCount: 0 };
}
function accumulate(total: NativeExpenseTotals, movement: DailyClinicExpenseMovement): void {
  const { currency, amountMinor } = movement;
  total.voucherCount = safeAdd(total.voucherCount, 1);
  if (movement.kind === "reversal") total.reversalCount = safeAdd(total.reversalCount, 1);
  if (movement.kind === "negative_adjustment") total.negativeAdjustmentCount = safeAdd(total.negativeAdjustmentCount, 1);
  if (amountMinor > 0) total.outflowMinor[currency] = safeAdd(total.outflowMinor[currency], amountMinor);
  if (amountMinor < 0) total.reversalMinor[currency] = safeAdd(total.reversalMinor[currency], -amountMinor);
  total.netOutflowMinor[currency] = safeAdd(total.netOutflowMinor[currency], amountMinor);
}

function timestamp(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== "string") reject();
  // Unzoned strings would depend on the server's timezone; PostgreSQL timestamptz is zoned.
  if (typeof value === "string" && (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)
    || !/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value))) reject();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) reject();
  return parsed;
}

function recipientOf(row: DailyClinicExpenseSourceRow): DailyClinicExpenseRecipient {
  const partyId = nullableId(row.party_id);
  const currentPartyName = nullableText(row.party_name);
  const recordedPayeeText = nullableText(row.payee_text);
  const recorded = recordedPayeeText?.trim() || null;
  const current = currentPartyName?.trim() || null;
  return {
    key: partyId !== null ? `party:${partyId}` : recorded !== null ? `text:${recorded}` : "missing",
    partyId, partyKind: nullableText(row.party_kind), currentPartyName, recordedPayeeText,
    displayName: current ?? recorded ?? (partyId !== null ? `جهة #${partyId} — الاسم غير متاح` : "مستفيد غير مسجّل"),
    nameSource: current ? "current_party" : recorded ? "recorded_text" : "missing",
  };
}

/** Pure projection used by the loader and synthetic unit fixtures. All selected-day rows are validated. */
export function buildDailyClinicExpenseReport(
  rows: readonly DailyClinicExpenseSourceRow[], query: DailyClinicExpenseQuery,
): DailyClinicExpenseReport {
  validateDailyClinicExpenseQuery(query);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: query.timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const seen = new Set<number>();
  const movements: DailyClinicExpenseMovement[] = [];
  let missingPayable = false;
  for (const row of rows) {
    const expenseId = id(row.id);
    if (seen.has(expenseId)) reject(); // A JOIN fanout must never multiply a voucher.
    seen.add(expenseId);
    const voucherNumber = requiredText(row.voucher_number);
    const created = timestamp(row.created_at);
    const parts = formatter.formatToParts(created);
    const part = (name: string) => parts.find((item) => item.type === name)?.value ?? reject();
    const clinicDate = `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
    if (clinicDate !== query.date) reject();
    const currency = requireCurrency(row.currency, "سند صرف", voucherNumber);
    const amountMinor = integer(row.amount_minor);
    const reversalOfId = nullableId(row.reversal_of_id);
    if (reversalOfId !== null && (amountMinor >= 0 || reversalOfId === expenseId)) reject();
    if (reversalOfId !== null && row.original_currency != null
      && requireCurrency(row.original_currency, "أصل سند الصرف", reversalOfId) !== currency) reject();
    const recipient = recipientOf(row);
    const payableId = nullableId(row.payable_id);
    const payableSourceType = sourceType(row.payable_source_type);
    if (payableId === null && (payableSourceType !== null || row.payable_party_id != null)) reject();
    if (payableId !== null && row.payable_party_id == null) missingPayable = true;
    if (row.payable_party_id != null && id(row.payable_party_id) !== recipient.partyId) reject();
    if (!Array.isArray(row.allocations)) reject();
    const allocationIds = new Set<number>();
    let allocated = 0;
    const allocations = row.allocations.map((raw): DailyClinicExpenseAllocation => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) reject();
      const piece = raw as Record<string, unknown>;
      const allocationId = id(piece.id);
      if (allocationIds.has(allocationId)) reject();
      allocationIds.add(allocationId);
      const billId = id(piece.payable_id);
      const paidMinor = integer(piece.paid_minor);
      const settledMinor = integer(piece.settled_minor);
      const billCurrency = requireCurrency(piece.payable_currency, "توزيع سند صرف", expenseId);
      if (piece.party_id != null && id(piece.party_id) !== recipient.partyId) reject();
      if (piece.party_id == null) missingPayable = true;
      if (Math.sign(paidMinor) !== Math.sign(amountMinor) || Math.sign(settledMinor) !== Math.sign(amountMinor)) reject();
      allocated = safeAdd(allocated, paidMinor);
      return { payableId: billId, sourceType: sourceType(piece.source_type), paidMinor,
        payableCurrency: billCurrency, settledMinor };
    });
    if ((payableId !== null && allocations.length > 0) || Math.abs(allocated) > Math.abs(amountMinor)) reject();
    const supplier = recipient.partyKind === "supplier" || recipient.partyKind === "lab";
    const categoryKey = requiredText(row.category);
    const movement: DailyClinicExpenseMovement = {
      id: expenseId, voucherNumber, createdAt: created.toISOString(), clinicDate,
      clinicTime: `${part("hour")}:${part("minute")}:${part("second")}`,
      shiftId: id(row.shift_id), categoryKey, categoryLabel: nullableText(row.category_name)?.trim() || categoryKey,
      recipient, amountMinor, currency, reversalOfId,
      kind: reversalOfId !== null ? "reversal" : amountMinor < 0 ? "negative_adjustment" : amountMinor > 0 ? "outflow" : "zero",
      originalVoucherNumber: nullableText(row.original_voucher_number), payableId, payableSourceType, allocations,
      unallocatedMinor: supplier
        ? payableId === null ? safeAdd(amountMinor, -allocated) : payableSourceType !== null ? 0 : null
        : null,
      note: nullableText(row.note), createdBy: nullableText(row.created_by),
    };
    // Validate before filtering: a selected-day unknown currency cannot vanish behind a filter.
    if (query.currency === undefined || query.currency === "all" || query.currency === currency) movements.push(movement);
  }
  movements.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  const totals = blankTotals();
  const recipientMap = new Map<string, DailyClinicRecipientTotals>();
  for (const movement of movements) {
    accumulate(totals, movement);
    let group = recipientMap.get(movement.recipient.key);
    if (!group) {
      const recipient = { ...movement.recipient };
      if (recipient.partyId !== null) {
        // A group can contain several recorded names. Do not pick the first as historical truth.
        recipient.recordedPayeeText = null;
        if (!recipient.currentPartyName?.trim()) {
          recipient.displayName = `جهة #${recipient.partyId} — الاسم الحالي غير متاح`;
          recipient.nameSource = "missing";
        }
      }
      group = { recipient, recordedPayeeTexts: [], totals: blankTotals() };
      recipientMap.set(movement.recipient.key, group);
    }
    // A stable recipient ID must not carry conflicting current identity in the same read snapshot.
    if (group.recipient.currentPartyName !== movement.recipient.currentPartyName
      || group.recipient.partyKind !== movement.recipient.partyKind) reject();
    const recorded = movement.recipient.recordedPayeeText;
    if (recorded !== null && !group.recordedPayeeTexts.includes(recorded)) group.recordedPayeeTexts.push(recorded);
    accumulate(group.totals, movement);
  }
  const caveats = [
    "يشمل الكشف سندات الصرف المسجّلة على مستوى المركز في يوم العيادة، ولا يمثّل قائمة مصروفات الاستحقاق أو كل القيود اليدوية والتحويلات.",
    "كل عملة مستقلة. الإبطالات والتصحيحات السالبة تظهر في يوم تسجيلها؛ صافي السندات ليس ربحًا.",
    "اسم الجهة المرتبطة هو اسمها الحالي؛ اسم المستفيد النصي المسجّل يظهر مستقلًا عند توافره، وليس لكل سند لقطة اسم تاريخية.",
    "السندات تخص درج النقد بحسب نموذج النظام. ردود المرضى وحوالاتهم تظهر في قسم حركات المرضى ولا تدخل هذه الإجماليات.",
    "السداد المرتبط أو على الحساب ليس تكلفة جديدة؛ الرصيد غير الموزع لا يثبت وحده أنه دفعة مقدمة جديدة.",
  ];
  if (missingPayable) caveats.push("بعض روابط الالتزامات غير متاحة؛ مبالغ السندات محفوظة دون افتراض نوع الالتزام المفقود.");
  if (movements.some((row) => row.recipient.nameSource === "missing")) caveats.push("توجد سندات لم يتوافر فيها اسم مستفيد؛ لم يُستنتج الاسم من بند المصروف أو مسجّل السند.");
  if (totals.negativeAdjustmentCount > 0) caveats.push("توجد مبالغ سالبة بلا رابط إبطال؛ تظهر كتصحيحات سالبة غير مرتبطة ويحتاج أصلها إلى مراجعة.");
  return { date: query.date, timeZone: query.timeZone, scope: "clinic_spending_vouchers", currency: query.currency ?? "all",
    movements, recipientTotals: [...recipientMap.values()], totals, caveats };
}

/** One SELECT, one row per voucher, no voucher-row limit or current exchange-rate conversion. */
export async function loadDailyClinicExpenseReport(
  query: DailyClinicExpenseQuery, runner: DailyClinicExpenseQueryRunner,
): Promise<DailyClinicExpenseReport> {
  validateDailyClinicExpenseQuery(query);
  const result = await runner.query(`
    SELECT e.id, e.voucher_number, e.created_at, e.shift_id, e.category,
           ec.name AS category_name, e.party_id, p.name AS party_name, p.kind AS party_kind,
           e.payee_text, e.amount_minor::text, e.currency, e.reversal_of_id,
           original.voucher_number AS original_voucher_number, original.currency AS original_currency,
           e.payable_id, bill.source_type AS payable_source_type, bill.party_id AS payable_party_id,
           COALESCE(a.allocations, '[]'::jsonb) AS allocations, e.note, e.created_by
      FROM expenses e
      LEFT JOIN parties p ON p.id = e.party_id
      LEFT JOIN payables bill ON bill.id = e.payable_id
      LEFT JOIN expenses original ON original.id = e.reversal_of_id
      LEFT JOIN LATERAL (
        SELECT c.name FROM expense_categories c
         WHERE c.key = e.category OR c.name = e.category
         ORDER BY (c.key = e.category) DESC, c.id LIMIT 1
      ) ec ON TRUE
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'id', x.id, 'payable_id', x.payable_id, 'paid_minor', x.paid_minor::text,
          'payable_currency', x.payable_currency, 'settled_minor', x.settled_minor::text,
          'source_type', b.source_type, 'party_id', b.party_id
        ) ORDER BY x.id) AS allocations
          FROM expense_payable_allocations x LEFT JOIN payables b ON b.id = x.payable_id
         WHERE x.expense_id = e.id
      ) a ON TRUE
     WHERE ${onClinicDaySql("e.created_at", "$1", "$2::date")}
     ORDER BY e.created_at, e.id`, [query.timeZone, query.date]);
  for (const row of result.rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) reject();
  }
  return buildDailyClinicExpenseReport(result.rows as DailyClinicExpenseSourceRow[], query);
}

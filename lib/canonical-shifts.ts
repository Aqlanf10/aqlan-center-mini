import "server-only";
import { CLINIC_TIME_ZONE, closeShiftWith, getOpenShiftWith, getPool, insertAuditRow, listShiftExpensesWith, listShiftPaymentsWith, listShiftsWith, openShiftWith, shiftDrawerBreakdown, type CashierShift, type Payment, type Expense } from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { readReceiptProvenanceInSnapshot } from "./receipt-provenance-db";
import type { ReceiptProvenance } from "./receipt-provenance";
import { CURRENCIES, formatMoney, parseAmount, type Currency } from "./money";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, withStaffOperation } from "./staff-operation-runtime";
import type { Amounts, DrawerBreakdown } from "./shift-close";

export const SHIFT_DETAIL_LIMIT = 1000;
type ShiftSummary = Omit<CashierShift, "note" | "differenceReason"> & Partial<Pick<CashierShift, "note" | "differenceReason">>;
type ShiftPayment = Pick<Payment, "id" | "receiptNumber" | "patientId" | "patientName" | "kind" | "amountMinor" | "currency" | "method" | "createdAt" | "note">;
type ShiftExpense = Pick<Expense, "id" | "voucherNumber" | "category" | "partyName" | "payeeText" | "amountMinor" | "currency" | "createdAt" | "note">;
export interface CanonicalShiftFeed {
  clinicTimeZone: string;
  open: ShiftSummary | null;
  drawer: DrawerBreakdown | null;
  recent: ShiftSummary[];
  canOperate: boolean;
  projection: { payments: boolean; expenses: boolean; notes: boolean; patientScope: "none" | "own" | "all" };
  payments?: ShiftPayment[];
  receiptProvenance?: Record<string, ReceiptProvenance>;
  paymentsTruncated?: boolean;
  expenses?: ShiftExpense[];
  expensesTruncated?: boolean;
}

/** Owner decision 2026-10-30: complete drawer aggregates under shifts.view;
 * receipt details additionally need payments.view AND the current patient scope;
 * expense details need expenses.view. Never derive drawer totals from filtered rows.
 * Free-text shift notes have no patient attribution, so require both detail grants
 * and the whole patient scope (the protected owner has all three).
 * No category/party/patient subtotals or hidden-row counts are published. */
export async function readCanonicalShifts(session: VerifiedDurableSession): Promise<CanonicalShiftFeed> {
  return runCanonicalReadSnapshot(session, "finance.shifts.view", async (query, scope) => {
    const payments = scope.granted("finance.payments.view") && scope.patientScope.kind !== "none";
    const expenses = scope.granted("finance.expenses.view");
    const notes = payments && expenses && scope.patientScope.kind === "all";
    const projectShift = ({ note, differenceReason, ...summary }: CashierShift): ShiftSummary =>
      ({ ...summary, ...(notes ? { note, differenceReason } : {}) });
    const open = await getOpenShiftWith(query);
    const drawer = open ? await shiftDrawerBreakdown(open, query) : null;
    const recent = await listShiftsWith(query, 15);
    const out: CanonicalShiftFeed = { clinicTimeZone: CLINIC_TIME_ZONE,
      open: open ? projectShift(open) : null, drawer, recent: recent.map(projectShift),
      canOperate: scope.granted("finance.shifts.operate"),
      projection: { payments, expenses, notes, patientScope: scope.patientScope.kind } };
    if (payments) {
      const rows = open ? await listShiftPaymentsWith(query, open.id, {
        doctorPartyId: scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null,
        limit: SHIFT_DETAIL_LIMIT + 1,
      }) : [];
      out.paymentsTruncated = rows.length > SHIFT_DETAIL_LIMIT;
      out.payments = rows.slice(0, SHIFT_DETAIL_LIMIT).map(({ id, receiptNumber, patientId, patientName, kind, amountMinor, currency, method, createdAt, note }) =>
        ({ id, receiptNumber, patientId, patientName, kind, amountMinor, currency, method, createdAt, note }));
      out.receiptProvenance = await readReceiptProvenanceInSnapshot(query, out.payments.map(row => row.id));
    }
    if (expenses) {
      const rows = open ? await listShiftExpensesWith(query, open.id, SHIFT_DETAIL_LIMIT + 1) : [];
      out.expensesTruncated = rows.length > SHIFT_DETAIL_LIMIT;
      out.expenses = rows.slice(0, SHIFT_DETAIL_LIMIT).map(({ id, voucherNumber, category, partyName, payeeText, amountMinor, currency, createdAt, note }) =>
        ({ id, voucherNumber, category, partyName, payeeText, amountMinor, currency, createdAt, note }));
    }
    return out;
  }, { errorPrefix: "STAFF_READ", maxBytes: 2 * 1024 * 1024 });
}

/** M2 slice 26. One clinic drawer, as in the existing shift contract. This lock
 * serializes canonical open/close commands even when no open row exists. It is
 * taken AFTER canonical authority, and BEFORE the same shift row lock used by
 * payment/expense writers. Their money writers and rules are unchanged. */
const SHIFT_LIFECYCLE_LOCK = "aqlan.canonical.cashier-shift-lifecycle.v1";
const ACTION = "finance.shifts.operate" as const;

export class CanonicalShiftRefusal extends Error {
  constructor(readonly code: "invalid_shift" | "shift_already_open" | "shift_not_open" | "difference_reason_required",
    readonly status: 400 | 409, message: string,
    readonly difference?: Amounts, readonly expected?: Amounts) {
    super(message);
    this.name = "CanonicalShiftRefusal";
  }
}

/** Same three currencies, major→minor conversion and empty→zero semantics as
 * the legacy route. Never accept caller-calculated expected balances or actor. */
function amounts(body: Record<string, unknown>, field: "opening" | "counted"): Amounts {
  const value = body[field] ?? {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CanonicalShiftRefusal("invalid_shift", 400, "المبالغ غير صالحة.");
  }
  const result: Record<Currency, number> = { YER: 0, SAR: 0, USD: 0 };
  for (const currency of CURRENCIES) {
    const raw = (value as Record<string, unknown>)[currency];
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string" && typeof raw !== "number") {
      throw new CanonicalShiftRefusal("invalid_shift", 400, "المبالغ غير صالحة.");
    }
    if (String(raw).trim() === "") continue;
    const minor = parseAmount(String(raw), currency);
    if (minor === null) throw new CanonicalShiftRefusal("invalid_shift", 400, field === "opening" ? "مبلغ افتتاحي غير صحيح." : "مبلغ الجرد غير صحيح.");
    result[currency] = minor;
  }
  return result;
}
const optionalText = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;

export async function commandCanonicalShiftOpen(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()) {
  const opening = amounts(body, "opening");
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [SHIFT_LIFECYCLE_LOCK]);
    const identity = await staffOperationIdentity(client, handle, ACTION);
    const shift = await openShiftWith(client, { openedBy: identity.username, opening });
    // INSERT may itself wait on a concurrently inserted unique open row.
    await staffOperationIdentity(client, handle, ACTION);
    if (!shift) throw new CanonicalShiftRefusal("shift_already_open", 409, "هناك وردية مفتوحة بالفعل. أغلقها أولًا.");
    await insertAuditRow(client, { action: "shift.open", entity: "shift", entityId: shift.id,
      details: { الافتتاحي: shift.opening }, actor: identity.username, actorRole: identity.role });
    return shift;
  });
}

export async function commandCanonicalShiftClose(session: VerifiedDurableSession, body: Record<string, unknown>, pool = getPool()) {
  const id = Number(body.id);
  if ((typeof body.id !== "number" && typeof body.id !== "string") || !Number.isSafeInteger(id) || id <= 0) {
    throw new CanonicalShiftRefusal("invalid_shift", 400, "رقم الوردية غير صالح.");
  }
  const counted = amounts(body, "counted"), note = optionalText(body.note), differenceReason = optionalText(body.differenceReason);
  return withStaffOperation(pool, session, ACTION, async (client, handle) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [SHIFT_LIFECYCLE_LOCK]);
    await staffOperationIdentity(client, handle, ACTION);
    // Re-prove admission AFTER the row wait and BEFORE reading the drawer or
    // writing. closeShiftWith reacquires this same held row on the same client.
    await client.query("SELECT id FROM cashier_shifts WHERE id=$1 AND status='open' FOR UPDATE", [id]);
    const identity = await staffOperationIdentity(client, handle, ACTION);
    const result = await closeShiftWith(client, { id, closedBy: identity.username, counted, note, differenceReason });
    if (result.reason === "not_open") throw new CanonicalShiftRefusal("shift_not_open", 409, "الوردية مغلقة بالفعل أو غير موجودة.");
    if (result.reason === "difference_reason_required" && result.difference && result.breakdown) {
      const parts = CURRENCIES.filter(currency => result.difference![currency] !== 0).map(currency => {
        const value = result.difference![currency];
        return `${value < 0 ? "عجز" : "زيادة"} ${formatMoney(Math.abs(value), currency)}`;
      });
      throw new CanonicalShiftRefusal("difference_reason_required", 409,
        `الجرد لا يطابق المتوقَّع (${parts.join("، ")}). راجع العدّ، وإن صحّ فاكتب سبب الفرق لإقفال الوردية.`,
        result.difference, result.breakdown.expected);
    }
    await insertAuditRow(client, { action: "shift.close", entity: "shift", entityId: id,
      details: { المعدود: counted, المتوقع: result.breakdown?.expected, الفرق: result.difference,
        سبب_الفرق: result.shift?.differenceReason ?? null, ملاحظة: note }, actor: identity.username, actorRole: identity.role });
    return result.shift;
  });
}

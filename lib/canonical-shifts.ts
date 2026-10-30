import "server-only";
import { closeShiftWith, getPool, insertAuditRow, openShiftWith } from "./db";
import { CURRENCIES, formatMoney, parseAmount, type Currency } from "./money";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationIdentity, withStaffOperation } from "./staff-operation-runtime";
import type { Amounts } from "./shift-close";

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

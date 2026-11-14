import "server-only";
import {
  CLINIC_TIME_ZONE, doctorOwnsPatient, getInvoice, getPool, getSettingsWith, insertAuditRow,
  invoiceLinkedPaymentsByCurrencyWith, setInvoiceStatusOn, type DbClient, type Invoice,
} from "./db";
import { formatMoney } from "./money";
import { clinicDateString } from "./schedule";
import {
  staffOperationIdentity, staffOperationPatientScope, withStaffOperation,
  type StaffOperationHandle,
} from "./staff-operation-runtime";
import type { VerifiedDurableSession } from "./staff-durable-session";

/**
 * Invoice status on the canonical runtime (M2 slice 93a; group 4 design:
 * docs/review/financial-group4-contract-design-20261104.md).
 *
 * `PATCH /api/invoices/[id]` carries three different decisions; each gets its own rule,
 * never wider than legacy:
 *  - `open` (reopen a paid invoice): `finance.invoices.create` (the map's grant; legacy
 *    admin and reception labels);
 *  - `cancelled`: `finance.invoices.cancel` (the catalogue's cancel grant; legacy admin
 *    label only), a written reason; the `invoice.cancel` audit row, with what was paid on
 *    the invoice, commits WITH the cancel (the legacy route wrote it after the commit);
 *  - `paid` without a receipt: `finance.invoices.mark-paid` (the catalogue grant named for
 *    exactly this; legacy admin label only).
 * One admitted operation; the legacy body (`setInvoiceStatusOn`) keeps its lock order, and
 * the decisions are made after every lock on the locked invoice row: the patient scope
 * (an `own` actor needs a positive ownership witness held FOR SHARE NOWAIT; outside or
 * missing read alike) and `finance.locked_before` against the invoice's clinic date.
 */
export class CanonicalInvoiceRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, message: string) { super(message); this.name = "CanonicalInvoiceRefusal"; }
}
const refuse = (code: string, status: 400 | 403 | 404 | 409, message: string) => new CanonicalInvoiceRefusal(code, status, message);
const MISSING = "الفاتورة غير موجودة.";

export type CanonicalInvoiceStatusCommand = { status: "open" | "paid" | "cancelled"; reason: string };
export function parseCanonicalInvoiceStatus(body: unknown): CanonicalInvoiceStatusCommand {
  const source = (body ?? {}) as Record<string, unknown>;
  const status = source.status;
  if (status !== "open" && status !== "paid" && status !== "cancelled") throw refuse("invalid_invoice_status", 400, "حالة غير معروفة.");
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 300) : "";
  if (status === "cancelled" && reason.length < 3) throw refuse("cancel_reason_required", 400, "اكتب سبب إلغاء الفاتورة.");
  return { status, reason };
}

/** The scope and period decisions on the locked invoice (called by the writer after its locks). */
function lockedInvoiceAdmission(client: DbClient, handle: StaffOperationHandle, action: "finance.invoices.create" | "finance.invoices.cancel" | "finance.invoices.mark-paid") {
  return async (invoice: { patientId: number; createdAt: Date }) => {
    const scope = await staffOperationPatientScope(client, handle, action);
    if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if (scope.kind === "own") {
      let inside: boolean;
      try { inside = await doctorOwnsPatient(scope.clinicianPartyId, invoice.patientId, client, "nowait"); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
          throw refuse("invoice_scope_conflict", 409, "تعذّر تثبيت نطاق المريض. حدّث الفاتورة وراجع النتيجة قبل طلب جديد.");
        }
        throw error;
      }
      if (!inside) throw refuse("invoice_not_found", 404, MISSING);
    }
    const boundary = ((await getSettingsWith(client))["finance.locked_before"] ?? "").trim();
    if (boundary && clinicDateString(invoice.createdAt, CLINIC_TIME_ZONE) < boundary) {
      throw refuse("period_locked", 409, "الفاتورة في فترة مقفلة. صحّحها بفاتورة أو قيد في الفترة المفتوحة.");
    }
  };
}

export async function commandCanonicalInvoiceStatus(session: VerifiedDurableSession, invoiceId: number, command: CanonicalInvoiceStatusCommand, pool = getPool()) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw refuse("invalid_invoice", 400, "رقم الفاتورة غير صالح.");
  const action = command.status === "cancelled" ? "finance.invoices.cancel" : command.status === "paid" ? "finance.invoices.mark-paid" : "finance.invoices.create";
  return withStaffOperation(pool, session, action, async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, action);
    const changed = await setInvoiceStatusOn(client, invoiceId, command.status, { actor: identity.username, actorRole: identity.role },
      lockedInvoiceAdmission(client, handle, action));
    if (!changed) throw refuse("invoice_cancelled_or_missing", 409, "الفاتورة غير موجودة أو ملغاة — والملغاة لا تُعاد.");
    const updated = await getInvoice(invoiceId, client) as Invoice;
    if (command.status !== "cancelled") return updated;
    const linked = await invoiceLinkedPaymentsByCurrencyWith(client, invoiceId);
    const paidText = linked.map(row => formatMoney(row.netMinor, row.currency)).join(" · ");
    await insertAuditRow(client, {
      action: "invoice.cancel", entity: "invoice", entityId: invoiceId, entityLabel: updated.invoiceNumber,
      details: {
        الصافي: updated.totalMinor - updated.discountMinor, العملة: updated.baseCurrency,
        المريض: updated.patientId, السبب: command.reason, مدفوع_عليها: linked.length > 0 ? paidText : null,
      },
      actor: identity.username, actorRole: identity.role,
    });
    return {
      ...updated,
      cancellation: {
        reason: command.reason, paidOnInvoice: linked,
        guidance: linked.length > 0
          ? `دُفع على هذه الفاتورة ${paidText}. المبلغ باقٍ رصيدًا دائنًا للمريض: استرده له من الصندوق، أو اتركه يسدّد فاتورته القادمة.`
          : null,
      },
    };
  });
}

export function isCanonicalInvoiceRefusal(error: unknown): error is CanonicalInvoiceRefusal { return error instanceof CanonicalInvoiceRefusal; }

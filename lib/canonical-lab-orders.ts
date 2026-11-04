import "server-only";
import {
  deleteLabOrderOn, getLabOrderWith, getPool, insertAuditRow, labOrderEventsWith, patientInDoctorScopeWith,
  setLabOrderDueDateOn, setLabOrderStatusOn, type DbClient, type LabStatusAuthority,
} from "./db";
import type { LabOrder, LabOrderStatus } from "./lab";
import { LabFinancialBoundaryError } from "./lab-financial-boundary";
import { clinicalLabOrder } from "./canonical-lab-reads";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { StaffRecordConstraint } from "./staff-capabilities";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities, staffOperationIdentity, staffOperationPatientScope, withStaffOperation,
  type StaffOperationHandle,
} from "./staff-operation-runtime";

/**
 * Canonical lab-order commands (M2 slice 67): PATCH /api/lab/[id] (status, due date,
 * events) and DELETE /api/lab/[id].
 *
 * - Status and due date: one admitted `clinical.lab.order` transaction. The order row is
 *   locked first; an order outside the patient scope answers like a missing one (`own`
 *   = the central DOCTOR_PATIENT_CONDITION; `none` refused). An optional
 *   `expectedStatus` (what the screen showed) is compared under the lock, so a stale
 *   screen never moves work another device already moved. The transition map, the
 *   prescription gate, the tracking row and the money effects are the legacy writer's
 *   own (setLabOrderStatusOn): an unpaid payable is removed on cancel and a paid one
 *   kept; receipt/fitting recognises the payable once (`ON CONFLICT (lab_order_id)`).
 * - Cancel after dispatch (status past `needed`) also needs `clinical.lab.cancel` (the
 *   map's field rule; the legacy route allowed the admin role label). Its audit row
 *   commits WITH the cancel (the legacy route wrote it after the commit).
 * - Events: a registered record read (`read:lab.events`, clinical.lab.view) inside the
 *   patient scope.
 * - Delete: one admitted `clinical.lab.cancel` transaction inside the patient scope,
 *   the legacy rules unchanged (source-linked or settled refused, reason required), the
 *   audit row with the delete (the legacy wrote it after the commit).
 * - Every other PATCH action (prescription, clinical and shade corrections, accounting
 *   and posting) is refused explicitly until its own slice: money and posting keep
 *   their legacy guards and are never reachable through this branch.
 */
export class CanonicalLabOrderRefusal extends Error {
  constructor(
    readonly code: "invalid_lab_order" | "lab_order_not_found" | "lab_status_changed" | "lab_action_not_canonical"
      | "lab_reason_required" | "lab_source_linked" | "lab_settled" | "lab_due_date_closed",
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "CanonicalLabOrderRefusal";
  }
}

const STATUSES: readonly LabOrderStatus[] = ["needed", "sent", "in_progress", "received", "delivered", "remake", "cancelled"];

/**
 * Post-dispatch moves (from any status past `needed`) that need `clinical.lab.cancel` in
 * addition to `clinical.lab.order`. OWNER DECISION 6616155745 (see
 * docs/review/lab-post-dispatch-policy-20261103.md): receipt, fitting, remake and return
 * stay with the explicit lab-update grant `clinical.lab.order`; cancel keeps its own
 * separate grant; viewing the module alone moves nothing. A matrix test pins this list.
 */
export const LAB_POST_DISPATCH_CANCEL_GUARDED: readonly LabOrderStatus[] = Object.freeze(["cancelled"] as const);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (message: string) => new CanonicalLabOrderRefusal("invalid_lab_order", 400, message);
const notFound = () => new CanonicalLabOrderRefusal("lab_order_not_found", 404, "أمر المختبر غير موجود.");

/** Digits only (`Number("1e3")` is an integer too). */
export function parseLabOrderId(raw: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(raw) || Number(raw) > 2147483647) throw invalid("رقم العمل غير صالح.");
  return Number(raw);
}

/** A real calendar date (PostgreSQL would reject 2031-02-31 with a driver error). */
function realDate(raw: unknown): string {
  if (typeof raw !== "string" || !DATE_PATTERN.test(raw)) throw invalid("تاريخ غير صالح.");
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw invalid("تاريخ غير صالح.");
  return raw;
}

function note(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 300) : null;
}

async function inScope(client: Pick<DbClient, "query">, scope: StaffRecordConstraint, patientId: number): Promise<boolean> {
  if (scope.kind === "all") return true;
  if (scope.kind === "own") return patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId);
  return false;
}

async function patientScopeOf(client: DbClient, handle: StaffOperationHandle, action: "clinical.lab.order" | "clinical.lab.cancel") {
  const scope = await staffOperationPatientScope(client, handle, action);
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  return scope;
}

/** The order as the actor may see it: the money group only with finance.cost-prices.view. */
async function projectedOrder(client: DbClient, handle: StaffOperationHandle, action: "clinical.lab.order", id: number) {
  const order = await getLabOrderWith(client, id);
  if (!order) throw notFound();
  const costs = (await staffOperationCapabilities(client, handle, action, ["finance.cost-prices.view"] as const)).has("finance.cost-prices.view");
  return { order: costs ? order : clinicalLabOrder(order), projection: { costs } };
}

/** The legacy writer's boundary refusals, as canonical refusals (scope reads as missing). */
function boundary(error: unknown): never {
  if (error instanceof LabFinancialBoundaryError && error.code === "lab_patient_forbidden") throw notFound();
  if (error instanceof LabFinancialBoundaryError && error.code === "lab_cancel_forbidden") throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
  throw error;
}

export async function commandCanonicalLabStatus(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = parseLabOrderId(rawId);
  const status = typeof body.status === "string" ? body.status as LabOrderStatus : null;
  if (!status || !STATUSES.includes(status)) throw invalid("حالة غير معروفة.");
  const expected = body.expectedStatus === undefined ? null : body.expectedStatus;
  if (expected !== null && (typeof expected !== "string" || !STATUSES.includes(expected as LabOrderStatus))) throw invalid("الحالة المتوقعة غير صالحة.");
  const notes = note(body.note);
  return withStaffOperation(pool, session, "clinical.lab.order", async (client, handle) => {
    const scope = await patientScopeOf(client, handle, "clinical.lab.order");
    // The row lock first: a concurrent move waits here and then reads the moved status.
    const { rows: [row] } = await client.query<{ status: string; patient_id: number }>(
      "SELECT status, patient_id FROM lab_orders WHERE id = $1 FOR UPDATE", [id]);
    if (!row || !await inScope(client, scope, row.patient_id)) throw notFound();
    if (expected !== null && row.status !== expected) {
      throw new CanonicalLabOrderRefusal("lab_status_changed", 409, "حالة العمل تغيّرت من جهاز آخر. حدّث القائمة وراجعها.");
    }
    const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");
    const cancel = (await staffOperationCapabilities(client, handle, "clinical.lab.order", ["clinical.lab.cancel"] as const)).has("clinical.lab.cancel");
    // The guarded post-dispatch moves, checked explicitly under the lock (the writer's own
    // cancel check below stays as a second line).
    if (row.status !== "needed" && LAB_POST_DISPATCH_CANCEL_GUARDED.includes(status) && !cancel) {
      throw new Error("STAFF_OPERATION_CAPABILITY_DENIED");
    }
    const authority: LabStatusAuthority = {
      actor: { username: identity.username, role: identity.role },
      canAccessPatient: patientId => inScope(client, scope, patientId),
      mayCancelSent: cancel,
    };
    const applied = await setLabOrderStatusOn(client, id, status, authority, { notes }).catch(boundary);
    if (!applied) throw new CanonicalLabOrderRefusal("lab_status_changed", 409, "لا يمكن نقل العمل إلى هذه الحالة من حالته الحالية؛ حدّث القائمة وراجعها.");
    const result = await projectedOrder(client, handle, "clinical.lab.order", id);
    if (status === "cancelled") {
      const full = await getLabOrderWith(client, id) as LabOrder;
      await insertAuditRow(client, {
        action: "lab_order.cancel", entity: "lab_order", entityId: id,
        entityLabel: `${full.patientName} — ${full.workType}`,
        details: {
          labName: full.labName, teeth: full.toothNumbers ?? null, from: row.status,
          costMinor: full.costMinor ?? null, costCurrency: full.costCurrency ?? null, note: notes,
        },
        actor: identity.username, actorRole: identity.role,
      });
    }
    return result;
  });
}

export async function commandCanonicalLabDueDate(session: VerifiedDurableSession, rawId: string, body: Record<string, unknown>, pool = getPool()) {
  const id = parseLabOrderId(rawId);
  const dueDate = realDate(body.dueDate);
  return withStaffOperation(pool, session, "clinical.lab.order", async (client, handle) => {
    const scope = await patientScopeOf(client, handle, "clinical.lab.order");
    const { rows: [row] } = await client.query<{ patient_id: number }>("SELECT patient_id FROM lab_orders WHERE id = $1 FOR UPDATE", [id]);
    if (!row || !await inScope(client, scope, row.patient_id)) throw notFound();
    const identity = await staffOperationIdentity(client, handle, "clinical.lab.order");
    if (!await setLabOrderDueDateOn(client, id, dueDate, { username: identity.username, role: identity.role })) {
      throw new CanonicalLabOrderRefusal("lab_due_date_closed", 409, "لا يمكن تغيير موعد عمل وصل أو رُكّب أو أُلغي.");
    }
    return projectedOrder(client, handle, "clinical.lab.order", id);
  });
}

export async function readCanonicalLabEvents(session: VerifiedDurableSession, rawId: string) {
  const id = parseLabOrderId(rawId);
  return runCanonicalReadSnapshot(session, "read:lab.events", async (query, scope) => {
    const { rows: [row] } = await query.query<{ patient_id: number }>("SELECT patient_id FROM lab_orders WHERE id = $1", [id]);
    if (!row || !await inScope(query, scope.patientScope, row.patient_id)) throw notFound();
    return { events: await labOrderEventsWith(query, id) };
  }, { errorPrefix: "STAFF_READ", maxBytes: 256 * 1024 });
}

export async function commandCanonicalLabDelete(session: VerifiedDurableSession, rawId: string, rawReason: unknown, pool = getPool()) {
  const id = parseLabOrderId(rawId);
  const reason = typeof rawReason === "string" && rawReason.trim() ? rawReason.trim().slice(0, 300) : null;
  if (!reason || reason.length < 3) {
    throw new CanonicalLabOrderRefusal("lab_reason_required", 400, "اكتب سبب الحذف النهائي — يُسجَّل في التدقيق. (للإلغاء الطبيعي استعمل «إلغاء» لا الحذف.)");
  }
  return withStaffOperation(pool, session, "clinical.lab.cancel", async (client, handle) => {
    const scope = await patientScopeOf(client, handle, "clinical.lab.cancel");
    const result = await deleteLabOrderOn(client, id, reason, patientId => inScope(client, scope, patientId));
    if (!result.ok) {
      if (result.reason === "source_linked") throw new CanonicalLabOrderRefusal("lab_source_linked", 409, "الإرسالية مرتبطة بمصدر علاجي أو فاتورة؛ لا يمكن حذف هويتها. استخدم الإلغاء المسموح مع حفظ الأثر.");
      if (result.reason === "settled") throw new CanonicalLabOrderRefusal("lab_settled", 409, "التزام هذا العمل مسدَّد بسند صرف — ألغِه سريريًا بدل حذفه ليبقى الأثر المالي.");
      if (result.reason === "reason_required") throw new CanonicalLabOrderRefusal("lab_reason_required", 400, "اكتب سبب الحذف النهائي — يُسجَّل في التدقيق.");
      throw notFound();
    }
    const identity = await staffOperationIdentity(client, handle, "clinical.lab.cancel");
    await insertAuditRow(client, {
      action: "lab_order.delete", entity: "lab_order", entityId: id, entityLabel: `#${id}`,
      details: result.snapshot, actor: identity.username, actorRole: identity.role,
    });
    return { ok: true as const };
  });
}

/** PATCH actions this slice does not migrate: refused explicitly in the canonical branch. */
export function canonicalLabActionNotMigrated(): never {
  throw new CanonicalLabOrderRefusal("lab_action_not_canonical", 409, "هذا الإجراء لم يُنقل بعد إلى الهوية الموحّدة.");
}

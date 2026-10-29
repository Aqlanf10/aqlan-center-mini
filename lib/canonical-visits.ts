import "server-only";
import { PlannedVisitStartConflict, ActiveVisitExists, addVisitWith, callVisitAgainWith, clearVisitWith, finishVisitWith, gatedVisitMoveWith, getPool, insertAuditRow, listTodayVisitsWith, patientInDoctorScopeWith, returnVisitToWaitingWith, startVisitFromPlannedVisitWith, type DbClient } from "./db";
import { normalizeEmergencyReason } from "./chair-readiness";
import { PATIENT_CARE_CAPABILITIES } from "./canonical-patient-reads";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import type { Visit } from "./flow";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { staffOperationClinician, staffOperationIdentity, staffOperationPatientScope, withStaffOperation, type StaffOperationHandle } from "./staff-operation-runtime";

/**
 * Canonical Today queue (M2 slice 11): GET /api/visits and the arrival POST /api/visits.
 *
 * Read: the registered record read `read:visits.today`, one owning RR snapshot. Rows
 * follow the actor's CURRENT patient scope: `all` lists every visit of the clinic day;
 * `own` lists the visits assigned to the actor's validated clinician party and the
 * visits of its patients (the patient list's condition). A role label never widens it.
 * Projection:
 *  - identity (every admitted actor): name, phone, status, chair, times, appointment
 *    and doctor links — what calling and seating need;
 *  - the arrival note: the operational summary (a clinical grant or
 *    `patients.operational-summary.view`), because a planned visit's note carries its
 *    clinical title.
 * `canManage` tells the screen whether `visits.manage` is held; the server proves it
 * again on every write.
 *
 * Arrival: one admitted `visits.manage` transaction. A visit for a patient file needs
 * that patient inside the actor's current scope (outside answers exactly like a
 * missing file, 404); a walk-in without a file needs no record. An `own`-scope actor
 * only opens visits on its own clinician party (default when no doctor is sent); an
 * `all`-scope actor may name any active doctor. The one-active-visit-per-patient-day
 * rule is unchanged. The audit row commits with the visit.
 * A planned-visit start locks the planned row, checks its patient against the scope
 * before any write, and moves its booked appointment to arrived in the same
 * transaction; its own refusals are unchanged.
 */
export const VISIT_QUEUE_MAX_BYTES = 1024 * 1024;

export class CanonicalVisitRefusal extends Error {
  constructor(
    readonly code: "invalid_visit_input" | "patient_not_found" | "visit_doctor_not_allowed" | "visit_already_active" | "planned_visit_not_found" | "planned_visit_conflict"
      | "visit_not_found" | "visit_move_conflict" | "visit_action_not_canonical" | "clearance_required" | "emergency_reason_required",
    readonly status: 400 | 403 | 404 | 409,
    message: string,
    readonly visitId?: number,
  ) {
    super(message);
    this.name = "CanonicalVisitRefusal";
  }
}

export type CanonicalQueueVisit = Omit<Visit, "note"> & { note?: string | null };
export interface CanonicalVisitQueue {
  readonly visits: readonly CanonicalQueueVisit[];
  readonly projection: { readonly note: boolean };
  readonly canManage: boolean;
}

export async function readCanonicalTodayVisits(session: VerifiedDurableSession): Promise<CanonicalVisitQueue> {
  return runCanonicalReadSnapshot(session, "read:visits.today", async (query, scope) => {
    const doctorPartyId = scope.patientScope.kind === "own" ? scope.patientScope.clinicianPartyId : null;
    if (scope.patientScope.kind !== "own" && scope.patientScope.kind !== "all") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const note = PATIENT_CARE_CAPABILITIES.some(capability => scope.granted(capability)) || scope.granted("patients.operational-summary.view");
    const visits = (await listTodayVisitsWith(query, doctorPartyId)).map(visit => {
      if (note) return visit;
      const { note: _hidden, ...visible } = visit;
      return visible;
    });
    return { visits, projection: { note }, canManage: scope.granted("visits.manage") };
  }, { errorPrefix: "STAFF_READ", maxBytes: VISIT_QUEUE_MAX_BYTES });
}

export interface CanonicalArrivalInput {
  readonly plannedVisitId: number | null;
  readonly patientName: string;
  readonly patientPhone: string | null;
  readonly note: string | null;
  readonly patientId: number | null;
  readonly doctorId: number | null;
}

const positiveId = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : NaN;
};

/** The arrival body, validated before admission (bounded Arabic refusals). */
export function parseCanonicalArrival(body: unknown): CanonicalArrivalInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  const allowed = new Set(["plannedVisitId", "patientName", "patientPhone", "note", "patientId", "doctorId"]);
  if (Object.keys(source).some(key => !allowed.has(key))) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "حقل غير معروف في طلب الوصول.");
  const plannedVisitId = positiveId(source.plannedVisitId);
  const patientId = positiveId(source.patientId);
  const doctorId = positiveId(source.doctorId);
  if ([plannedVisitId, patientId, doctorId].some(Number.isNaN)) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "رقم غير صالح في طلب الوصول.");
  if (plannedVisitId !== null) {
    if (patientId !== null || doctorId !== null || source.patientName !== undefined) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "بدء الجلسة المخطَّطة يأخذ رقمها وحده.");
    return { plannedVisitId, patientName: "", patientPhone: null, note: null, patientId: null, doctorId: null };
  }
  const text = (value: unknown) => typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : null;
  const patientName = text(source.patientName), phone = text(source.patientPhone), note = text(source.note);
  if (patientName === null || phone === null || note === null) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "طلب غير صالح.");
  if (!patientName) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "اسم المريض مطلوب.");
  if (patientName.length > 120) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "اسم المريض طويل أكثر من اللازم.");
  if (phone.length > 40) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "رقم الجوال طويل أكثر من اللازم.");
  return { plannedVisitId: null, patientName, patientPhone: phone || null, note: note ? note.slice(0, 300) : null, patientId, doctorId };
}

const NOT_FOUND = "لا يوجد مريض بهذا الرقم ضمن مرضاك.";
async function requirePatientInScope(client: DbClient, handle: StaffOperationHandle, patientId: number, lock: boolean): Promise<void> {
  const scope = await staffOperationPatientScope(client, handle, "visits.manage");
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows } = await client.query(`SELECT id FROM patients WHERE id = $1${lock ? " FOR SHARE" : ""}`, [patientId]);
  const inside = rows.length === 1 && (scope.kind === "all" || await patientInDoctorScopeWith(client, scope.clinicianPartyId, patientId));
  if (!inside) throw new CanonicalVisitRefusal("patient_not_found", 404, NOT_FOUND);
}

export async function commandCanonicalArrival(session: VerifiedDurableSession, input: CanonicalArrivalInput, pool = getPool()): Promise<Visit> {
  try {
    return await withStaffOperation(pool, session, "visits.manage", async (client, handle) => {
      const actor = await staffOperationIdentity(client, handle, "visits.manage");
      if (input.plannedVisitId !== null) {
        const started = await startVisitFromPlannedVisitWith(client, {
          plannedVisitId: input.plannedVisitId, actor: actor.username, actorRole: actor.role,
          admit: patientId => requirePatientInScope(client, handle, patientId, false),
        });
        if (!started) throw new CanonicalVisitRefusal("planned_visit_not_found", 404, "الزيارة المخطَّطة غير موجودة أو لا يمكن بدؤها.");
        if ("appointmentConflict" in started) throw new CanonicalVisitRefusal("planned_visit_conflict", 409, "تغيّر الموعد المرتبط أو أُغلق. أعد الحجز قبل بدء الجلسة.");
        if ("alreadyActive" in started) throw new CanonicalVisitRefusal("visit_already_active", 409, "لهذه الجلسة زيارة قائمة سلفًا.", started.visitId);
        await insertAuditRow(client, {
          action: "visit.create", entity: "visit", entityId: started.id, entityLabel: started.patientName,
          details: { المصدر: "جلسة مخططة", الجلسة_المخططة: input.plannedVisitId }, actor: actor.username, actorRole: actor.role,
        });
        return started;
      }
      const scope = await staffOperationPatientScope(client, handle, "visits.manage");
      if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
      if (input.patientId !== null) await requirePatientInScope(client, handle, input.patientId, true);
      let doctorId = input.doctorId;
      if (scope.kind === "own") {
        const own = await staffOperationClinician(client, handle, "visits.manage");
        if (own === null || (doctorId !== null && doctorId !== own)) throw new CanonicalVisitRefusal("visit_doctor_not_allowed", 403, "تفتح زيارات مرضاك على اسمك فقط.");
        doctorId = own;
      } else if (doctorId !== null) {
        const { rows } = await client.query("SELECT 1 FROM parties WHERE id = $1 AND kind = 'doctor' AND is_active FOR SHARE", [doctorId]);
        if (rows.length !== 1) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "الطبيب المحدد غير موجود أو غير نشط.");
      }
      const visit = await addVisitWith(client, { patientName: input.patientName, patientPhone: input.patientPhone, note: input.note, patientId: input.patientId, doctorId });
      await insertAuditRow(client, {
        action: "visit.create", entity: "visit", entityId: visit.id, entityLabel: visit.patientName,
        details: { المصدر: "دخول مباشر", المريض: input.patientId, الطبيب: doctorId }, actor: actor.username, actorRole: actor.role,
      });
      return visit;
    });
  } catch (error) {
    if (error instanceof ActiveVisitExists) throw new CanonicalVisitRefusal("visit_already_active", 409, error.message, error.visitId);
    if (error instanceof PlannedVisitStartConflict) throw new CanonicalVisitRefusal("planned_visit_conflict", 409, "تغيّر الموعد المرتبط أو أُغلق. أعد الحجز قبل بدء الجلسة.");
    throw error;
  }
}

/* ---------------------------------------------------------------------------
 * M2 slice 12: queue moves (PATCH /api/visits/[id]) — call, call again, seat, return to
 * waiting, finish, and the readiness acknowledgement (clear).
 *
 * One admitted `visits.manage` transaction each. The locks are taken in the legacy
 * order (the chair-day lock for call and seat, then the visit row FOR UPDATE); the
 * record-scope check runs once the row is locked, with the queue read's condition:
 * `all`, or `own` when the visit is assigned to the actor's clinician party or its
 * patient is one of the clinician's patients. A missing visit and one outside the
 * scope answer identically (404). The readiness gate and the written emergency
 * reason are unchanged; every move writes its audit row in the same transaction.
 * Deferring payment (a money decision), linking a walk-in to a file and opening a
 * file are not canonical yet and refuse (409).
 * ------------------------------------------------------------------------- */
const QUEUE_ACTIONS = ["call", "call_again", "seat", "return", "finish", "clear"] as const;
type QueueAction = typeof QUEUE_ACTIONS[number];
export interface CanonicalVisitMove {
  readonly action: QueueAction;
  readonly chair: number | null;
  readonly emergency: { readonly requested: boolean; readonly reason: string | null };
}

export function parseCanonicalVisitMove(body: unknown): CanonicalVisitMove {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "طلب غير صالح.");
  const source = body as Record<string, unknown>;
  const action = source.action;
  if (action === "defer" || action === "link" || action === "open_file") {
    throw new CanonicalVisitRefusal("visit_action_not_canonical", 409, "هذا الإجراء لم يُنقل بعد إلى الهوية الموحّدة.");
  }
  if (typeof action !== "string" || !(QUEUE_ACTIONS as readonly string[]).includes(action)) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "إجراء غير معروف.");
  let chair: number | null = null;
  if (action === "call" || action === "seat") {
    chair = Number(source.chair);
    if (!Number.isSafeInteger(chair) || chair <= 0 || chair > 100) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "رقم الكرسي غير صالح.");
  }
  return { action: action as QueueAction, chair, emergency: { requested: source.emergency === true, reason: normalizeEmergencyReason(source.emergencyReason) } };
}

const VISIT_NOT_FOUND = "لا توجد زيارة بهذا الرقم ضمن مرضاك.";
async function requireVisitInScope(client: DbClient, handle: StaffOperationHandle, visitId: number): Promise<void> {
  const scope = await staffOperationPatientScope(client, handle, "visits.manage");
  if (scope.kind === "none") throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  const { rows: [visit] } = await client.query<{ patient_id: number | null; doctor_id: number | null }>(
    "SELECT patient_id, doctor_id FROM visits WHERE id = $1", [visitId]);
  const inside = visit !== undefined && (scope.kind === "all" || visit.doctor_id === scope.clinicianPartyId
    || (visit.patient_id !== null && await patientInDoctorScopeWith(client, scope.clinicianPartyId, visit.patient_id)));
  if (!inside) throw new CanonicalVisitRefusal("visit_not_found", 404, VISIT_NOT_FOUND);
}

export type CanonicalVisitMoveResult =
  | { readonly kind: "visit"; readonly visit: Visit; readonly warning: string | null }
  | { readonly kind: "cleared"; readonly clearedAt: string; readonly clearedBy: string; readonly already: boolean };

export async function commandCanonicalVisitMove(session: VerifiedDurableSession, visitId: number, move: CanonicalVisitMove, pool = getPool()): Promise<CanonicalVisitMoveResult> {
  if (!Number.isSafeInteger(visitId) || visitId <= 0) throw new CanonicalVisitRefusal("invalid_visit_input", 400, "رقم الزيارة غير صالح.");
  return withStaffOperation(pool, session, "visits.manage", async (client, handle) => {
    const identity = await staffOperationIdentity(client, handle, "visits.manage");
    const actor = { actor: identity.username, actorRole: identity.role };
    const admit = (id: number) => requireVisitInScope(client, handle, id);
    const conflict = (message: string): never => { throw new CanonicalVisitRefusal("visit_move_conflict", 409, message); };
    switch (move.action) {
      case "call":
      case "seat": {
        const result = await gatedVisitMoveWith(client, move.action, visitId, move.chair!, actor, move.emergency, admit);
        if (result.ok) return { kind: "visit", visit: result.visit, warning: result.warning };
        if (result.reason === "gate") throw new CanonicalVisitRefusal(result.code, 409, result.message);
        return conflict(move.action === "call"
          ? "الكرسي محجوز لمريض آخر أو تغيّرت حالة المريض. حدّثت اللوحة — راجعها."
          : "الكرسي شُغل للتو أو تغيّرت حالة المريض. حدّثت اللوحة — راجعها.");
      }
      case "call_again": {
        const visit = await callVisitAgainWith(client, visitId, actor, admit);
        return visit ? { kind: "visit", visit, warning: null } : conflict("لا يوجد نداء قائم لإعادته — ربما دخل المريض الكرسي أو عاد للانتظار.");
      }
      case "return": {
        const visit = await returnVisitToWaitingWith(client, visitId, actor, admit);
        return visit ? { kind: "visit", visit, warning: null } : conflict("المريض لم يعد في حالة نداء.");
      }
      case "finish": {
        const visit = await finishVisitWith(client, visitId, actor, admit);
        return visit ? { kind: "visit", visit, warning: null } : conflict("الزيارة منتهية بالفعل.");
      }
      case "clear": {
        const cleared = await clearVisitWith(client, visitId, actor, admit);
        if (!cleared.ok) {
          if (cleared.reason === "not_found") throw new CanonicalVisitRefusal("visit_not_found", 404, VISIT_NOT_FOUND);
          return conflict("الزيارة منتهية — لا جاهزية تُقَرّ بعدها.");
        }
        return { kind: "cleared", clearedAt: cleared.clearedAt, clearedBy: cleared.clearedBy, already: cleared.already };
      }
    }
  });
}

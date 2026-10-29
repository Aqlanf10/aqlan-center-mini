import "server-only";
import { PlannedVisitStartConflict, ActiveVisitExists, addVisitWith, getPool, insertAuditRow, listTodayVisitsWith, patientInDoctorScopeWith, startVisitFromPlannedVisitWith, type DbClient } from "./db";
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
    readonly code: "invalid_visit_input" | "patient_not_found" | "visit_doctor_not_allowed" | "visit_already_active" | "planned_visit_not_found" | "planned_visit_conflict",
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

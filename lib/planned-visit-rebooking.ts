import {
  CLINIC_TIME_ZONE, getPool, insertAppointmentOnClient, insertAuditRow,
  lockAppointmentServiceForBooking, transitionInternalReferralOnClient, writeAppointmentInDay,
  type DbClient,
} from "./db";
import type { SessionPayload } from "./auth";
import { revalidateSessionInTransaction } from "./session";
import { canAccessPatient } from "./patient-access";
import { canActOnReferral } from "./referrals";
import { lockBookableAppointmentDoctor } from "./appointment-doctor";
import { loadCapacityContext } from "./capacity-context";
import { judgeBookingInDay } from "./book-appointment";
import { PURCHASE_RESET_FENCE } from "./clinic-reset";
import type { BookingConflict } from "./book-appointment";
import {
  parsePlannedRebookIntent, PLANNED_REBOOK_BLOCK_REASON_SQL, PLANNED_REBOOK_REASONS, PLANNED_REBOOK_GENERATION_SQL,
  type PlannedRebookBlockReason, type PlannedRebookIntent,
} from "./planned-visit-rebooking-contract";
import { MAX_DURATION, MIN_DURATION } from "./appointment-services";

export type PlannedRebookResult =
  | { ok: true; appointmentId: number; title: string; replayed: boolean }
  | { ok: false; status: 400 | 401 | 403 | 404 | 409; message: string; conflict?: BookingConflict };
type Success = Extract<PlannedRebookResult, { ok: true }>;
class RebookRejected extends Error {
  constructor(readonly result: Exclude<PlannedRebookResult, { ok: true }>) { super(result.message); }
}
function reject(status: 400 | 401 | 403 | 404 | 409, message: string): never {
  throw new RebookRejected({ ok: false, status, message });
}
interface LockedPlan {
  id: number; patient_id: number; appointment_id: number | null; title: string;
  duration_minutes: number; doctor_id: number | null;
}
interface LockedAppointment {
  id: number; patient_id: number; referral_id: number | null; planned_visit_id: number | null;
  doctor_id: number | null; service_id: number | null; appointment_type: string | null;
  chair_no: number | null; is_new_patient: boolean; snapshot: Record<string, unknown>;
}
const STALE = "تغيّرت الجلسة أو موعدها. حدّث الملف قبل إعادة الحجز.";
const INTENT_CONFLICT = "استُخدم رقم هذه المحاولة لطلب مختلف. حدّث الملف قبل محاولة جديدة.";

/** One atomic appointment-only rebooking. Never reopens or edits old attendance.
 * Lock order: shared reset fence -> destination day -> existing appointments
 * (ascending) -> planned row
 * -> current user/clinical ownership/service/doctor -> referral. Receipt identity is
 * scoped to (planned visit, authenticated user ID, request ID), serialized by the
 * planned row and retained in append-only audit_log. No migration is needed.
 * Replays bypass capacity/lifecycle, not current session or patient-read access.
 */
export async function rebookPlannedVisit(input: PlannedRebookIntent, admitted: SessionPayload): Promise<PlannedRebookResult> {
  const parsed = parsePlannedRebookIntent(input.plannedVisitId, {
    expectedAppointmentId: input.expectedAppointmentId, expectedGeneration: input.expectedGeneration, date: input.date, time: input.time,
    reason: input.reason, requestId: input.requestId,
  });
  if (!parsed) return { ok: false, status: 400, message: "أدخل موعدًا صحيحًا وسبب إعادة الحجز ورقم محاولة صالحًا." };
  input = parsed;
  if (!["admin", "reception", "doctor"].includes(admitted.role)) return { ok: false, status: 403, message: "غير مصرّح لك بإعادة الحجز." };
  const capacityContext = await loadCapacityContext();
  // Never trust this unlocked preview for writing. It only identifies all referral
  // appointment locks that must precede the planned row; a changed set is rejected.
  const { rows: previewRows } = await getPool().query<{ referral_id: number | null }>(
    "SELECT referral_id FROM appointments WHERE id = $1", [input.expectedAppointmentId]);
  const previewReferralId = previewRows[0]?.referral_id ?? null;
  let replay: Success | null = null;
  let plan: LockedPlan | undefined;
  let old: LockedAppointment | undefined;
  let session: SessionPayload | null = null;
  let appointmentLocks: number[] = [];
  let service: Awaited<ReturnType<typeof lockAppointmentServiceForBooking>> = null;
  let doctorId: number | null = null;
  const intent = { plannedVisitId: input.plannedVisitId, expectedAppointmentId: input.expectedAppointmentId,
    expectedGeneration: input.expectedGeneration,
    date: input.date, time: input.time, reason: input.reason };
  try {
    const result = await writeAppointmentInDay({
      date: input.date,
      // Reset takes this existing fence exclusively before acquiring wipe-table
      // locks. Cooperate before the day lock or any table read, avoiding a reversed
      // reset-table/FK lock cycle without changing ordinary booking or reset.
      beforeLocks: async client => {
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [PURCHASE_RESET_FENCE]);
      },
      judge: async (day, client) => {
        const { rows: locked } = await client.query<LockedAppointment>(
          `SELECT a.id, a.patient_id, a.referral_id, a.planned_visit_id, a.doctor_id,
             a.service_id, a.appointment_type, a.chair_no, a.is_new_patient, to_jsonb(a) AS snapshot
           FROM appointments a WHERE a.id = $2 OR a.planned_visit_id = $1
             OR a.id = (SELECT appointment_id FROM planned_visits WHERE id = $1)
             OR ($3::int IS NOT NULL AND a.referral_id = $3)
           ORDER BY a.id FOR UPDATE`, [input.plannedVisitId, input.expectedAppointmentId, previewReferralId]);
        appointmentLocks = locked.map(row => row.id);
        const { rows: plans } = await client.query<LockedPlan>(
          `SELECT id, patient_id, appointment_id, title, duration_minutes, doctor_id
           FROM planned_visits WHERE id = $1 FOR UPDATE`, [input.plannedVisitId]);
        plan = plans[0];
        if (!plan) reject(404, "الزيارة المخطَّطة غير موجودة.");
        session = await revalidateSessionInTransaction(admitted, client);
        if (!session) reject(401, "انتهت الجلسة أو تغيّرت صلاحيات الحساب. سجّل الدخول من جديد.");
        if (!await canAccessPatient(session, plan.patient_id, undefined, client, "nowait")) reject(403, "غير مصرّح لك بملف هذا المريض.");
        // Reset keeps users/audit but reuses clinical IDs. The held planned and
        // appointment table locks conflict with its EXCLUSIVE/TRUNCATE locks.
        // Check the generation here, not in the unlocked preview, and reject old
        // saved AND unsaved intents before receipt success or any new write.
        const { rows: [generation] } = await client.query<{ value: string }>(`SELECT ${PLANNED_REBOOK_GENERATION_SQL} AS value`);
        if (generation.value !== input.expectedGeneration) reject(409, "أُعيدت تهيئة بيانات المركز. حدّث الملف وابدأ طلب حجز جديدًا.");
        const { rows: receipts } = await client.query<{ details: { intent: typeof intent; response: { appointmentId: number; title: string }; patientId: number } }>(
          `SELECT details FROM audit_log WHERE entity = 'planned_visit' AND entity_id = $1
             AND action = 'planned_visit.rebook' AND details->>'requestId' = $2
             AND details->>'actorUserId' = $3 ORDER BY id`,
          [String(input.plannedVisitId), input.requestId, String(session.userId)]);
        if (receipts.length > 1) reject(409, "سجل إعادة الحجز يحتاج مراجعة. لم يُنشأ موعد آخر.");
        if (receipts[0]) {
          const saved = receipts[0].details;
          if (saved.patientId !== plan.patient_id || Object.entries(intent).some(([key, value]) => saved.intent?.[key as keyof typeof intent] !== value)) reject(409, INTENT_CONFLICT);
          if (!Number.isSafeInteger(saved.response?.appointmentId) || typeof saved.response?.title !== "string") reject(409, "تعذّر التحقق من نتيجة المحاولة السابقة. حدّث الملف.");
          replay = { ok: true, ...saved.response, replayed: true };
          return { ok: true };
        }
        // Read again after waiting for the planned row. Never lock newly discovered
        // appointment IDs now: that would invert the shared lifecycle lock order.
        const { rows: currentLinks } = await client.query<{ id: number }>(
          `SELECT id FROM appointments WHERE planned_visit_id = $1 OR id = $2 ORDER BY id`,
          [input.plannedVisitId, plan.appointment_id]);
        old = locked.find(row => row.id === input.expectedAppointmentId);
        if (!old || plan.appointment_id !== old.id || old.referral_id !== previewReferralId
          || currentLinks.length !== 1 || currentLinks[0].id !== old.id
          || old.patient_id !== plan.patient_id) reject(409, STALE);
        // Signing may lock sessions/items before closing their planned visit.
        // NOWAIT fails closed instead of waiting in that reverse clinical order;
        // protected snapshots cannot become completed between eligibility and commit.
        await client.query(`SELECT t.id FROM treatment_plans t
          WHERE t.id = (SELECT v.plan_id FROM planned_visits v WHERE v.id = $1)
            OR EXISTS (SELECT 1 FROM plan_items i JOIN treatment_sessions s ON s.plan_item_id = i.id
              WHERE i.plan_id = t.id AND s.planned_visit_id = $1)
          ORDER BY t.id FOR SHARE OF t NOWAIT`, [plan.id]);
        await client.query(`SELECT s.id FROM treatment_sessions s WHERE s.planned_visit_id = $1
          ORDER BY s.id FOR SHARE NOWAIT`, [plan.id]);
        await client.query(`SELECT i.id FROM plan_items i WHERE i.id IN
          (SELECT s.plan_item_id FROM treatment_sessions s WHERE s.planned_visit_id = $1)
          ORDER BY i.id FOR SHARE NOWAIT`, [plan.id]);
        const { rows: [eligibility] } = await client.query<{ reason: PlannedRebookBlockReason | null }>(
          `SELECT ${PLANNED_REBOOK_BLOCK_REASON_SQL} AS reason FROM planned_visits v
             LEFT JOIN appointments a ON a.id = v.appointment_id
             LEFT JOIN treatment_plans t ON t.id = v.plan_id
             LEFT JOIN patient_referrals r ON r.id = a.referral_id WHERE v.id = $1`, [plan.id]);
        if (!eligibility || eligibility.reason) reject(409, eligibility ? PLANNED_REBOOK_REASONS[eligibility.reason!] : STALE);
        const { rows: [future] } = await client.query<{ valid: boolean }>(
          `SELECT $1::date + $2::time > clock_timestamp() AT TIME ZONE $3 AS valid`, [input.date, input.time, CLINIC_TIME_ZONE]);
        if (!future.valid) reject(400, "اختر موعدًا قادمًا بتوقيت العيادة.");
        if (!Number.isInteger(plan.duration_minutes) || plan.duration_minutes < MIN_DURATION || plan.duration_minutes > MAX_DURATION) reject(409, "مدة الجلسة تحتاج مراجعة قبل إعادة الحجز.");
        doctorId = plan.doctor_id ?? old.doctor_id;
        if (!await lockBookableAppointmentDoctor(client, doctorId)) reject(409, "الطبيب غير متاح للحجز.");
        let serviceId = old.service_id;
        if (!serviceId && old.appointment_type) {
          const { rows: legacy } = await client.query<{ id: number }>(
            `SELECT id FROM appointment_services WHERE legacy_type = $1 OR code = $1 ORDER BY is_active DESC, id LIMIT 1`, [old.appointment_type]);
          serviceId = legacy[0]?.id ?? null;
        }
        service = serviceId ? await lockAppointmentServiceForBooking(client, serviceId) : null;
        if (serviceId && !service?.isActive) reject(409, "خدمة الموعد غير متاحة للحجز. راجع الجلسة أولًا.");
        if (old.chair_no !== null && (old.chair_no < 1 || old.chair_no > capacityContext.chairs)) reject(409, "كرسي الموعد غير متاح. راجع الجلسة أولًا.");
        const judged = await judgeBookingInDay({ sameDay: day, client, date: input.date, time: input.time,
          durationMinutes: plan.duration_minutes, service, context: capacityContext,
          providerId: doctorId, chairNo: old.chair_no, isNewPatient: old.is_new_patient,
          patientId: plan.patient_id, canOverride: false, overrideReason: "" });
        return judged.ok ? { ok: true } : { ok: false, conflict: judged.conflict };
      },
      commit: async (client: DbClient): Promise<Success> => {
        if (!await revalidateSessionInTransaction(admitted, client)) reject(401, "انتهت الجلسة. سجّل الدخول وأعد المحاولة نفسها.");
        if (replay) return replay;
        if (!plan || !old || !session) throw new Error("Missing locked rebooking context");
        const created = await insertAppointmentOnClient(client, {
          patientId: plan.patient_id, date: input.date, time: input.time, durationMinutes: plan.duration_minutes,
          note: `من خطة العلاج: ${plan.title}`, doctorId, serviceId: service?.id ?? null,
          appointmentType: old.appointment_type ?? service?.legacyType ?? null,
          bufferBeforeMinutes: service?.bufferBeforeMinutes ?? 0, bufferAfterMinutes: service?.bufferAfterMinutes ?? 0,
          occupiesChair: service?.requiresChair ?? true, chairNo: old.chair_no, isNewPatient: old.is_new_patient,
        });
        if (!created) throw new Error("Replacement appointment was not inserted");
        if (old.referral_id !== null) {
          const referral = await transitionInternalReferralOnClient(client, {
            id: old.referral_id, action: "schedule", appointmentId: created.id,
            actor: session.username, actorRole: session.role, note: input.reason,
            procedurePerformed: null, followupRequired: null, mayReturn: null,
          }, {
            lockedAppointmentIds: [...appointmentLocks, created.id],
            authorize: async current => {
              if (current.patient_id !== plan!.patient_id || current.to_party_id !== doctorId) reject(409, STALE);
              if (!canActOnReferral({ action: "schedule", role: session!.role, actorPartyId: session!.partyId ?? null,
                referringPartyId: current.doctor_party_id, receivingPartyId: current.to_party_id })) reject(403, "إعادة حجز الإحالة للاستقبال أو الطبيب المحال إليه.");
              const { rows: [currentReferral] } = await client.query<{ workflow_state: string }>(
                "SELECT workflow_state FROM patient_referrals WHERE id = $1", [old!.referral_id]);
              if (!["requested", "accepted"].includes(currentReferral?.workflow_state)) reject(409, "تغيّرت حالة الإحالة. حدّث الملف.");
            },
          });
          if (!referral.ok) reject(409, "تعذّر ربط موعد الإحالة. حدّث الملف وراجع حالتها.");
        }
        if (!await revalidateSessionInTransaction(admitted, client)) reject(401, "انتهت الجلسة أثناء الحجز. سجّل الدخول وأعد المحاولة نفسها.");
        // Only the live inverse pointer moves. Historical status, timestamps,
        // cancellation reason, referral identity and status log remain untouched.
        await client.query("UPDATE appointments SET planned_visit_id = NULL WHERE id = $1 AND planned_visit_id = $2", [old.id, plan.id]);
        await client.query("UPDATE appointments SET planned_visit_id = $2 WHERE id = $1", [created.id, plan.id]);
        await client.query("UPDATE planned_visits SET appointment_id = $2, status = 'scheduled' WHERE id = $1", [plan.id, created.id]);
        const { rows: [replacement] } = await client.query<{ snapshot: Record<string, unknown> }>("SELECT to_jsonb(a) AS snapshot FROM appointments a WHERE id = $1", [created.id]);
        const response = { appointmentId: created.id, title: plan.title };
        await insertAuditRow(client, {
          action: "planned_visit.rebook", entity: "planned_visit", entityId: plan.id,
          entityLabel: plan.title, actor: session.username, actorRole: session.role,
          details: { requestId: input.requestId, actorUserId: session.userId, patientId: plan.patient_id,
            intent, response, oldAppointmentId: old.id, newAppointmentId: created.id,
            oldAppointment: old.snapshot, newAppointment: replacement.snapshot },
        });
        if (admitted.expiresAt < Date.now()) reject(401, "انتهت الجلسة أثناء الحجز. سجّل الدخول وأعد المحاولة نفسها.");
        return { ok: true, ...response, replayed: false };
      },
    });
    return result.ok ? result.value : { ok: false, status: 409,
      message: (result.conflict as BookingConflict).message, conflict: result.conflict as BookingConflict };
  } catch (error) {
    if (error instanceof RebookRejected) return error.result;
    if ((error as { code?: string }).code === "55P03") return { ok: false, status: 409,
      message: "يجري تحديث العلاج المرتبط بهذه الجلسة. حدّث الملف وأعد المحاولة." };
    throw error;
  }
}

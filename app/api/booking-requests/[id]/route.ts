import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { bookingRequestPatientChoices, CLINIC_TIME_ZONE, confirmBookingRequest, existingPatientForBookingRequest,
  findUserByUsername, getAppointment, getBookingRequest, getPool, getSettingsInTransaction,
  lockAppointmentServiceForBooking, rejectBookingRequest, writeAppointmentInDay } from "@/lib/db";
import { loadCapacityContext, resolveService } from "@/lib/capacity-context";
import type { CapacityVerdict } from "@/lib/capacity";
import { actorCanOverride, judgeBookingInDay, recordCapacityOverride } from "@/lib/book-appointment";
import { lockBookableAppointmentDoctor } from "@/lib/appointment-doctor";
import { assertBookingRequestDuty, bookingRequestDoctor } from "@/lib/booking-request-review";
import { MAX_DURATION, MIN_DURATION } from "@/lib/appointment-services";
import { clinicDateString } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
const json = (message: string, status: number) => NextResponse.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
const positiveId = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const dateValid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const errors: Record<string, string> = {
  BOOKING_PATIENT_AMBIGUOUS: "أكثر من ملف يحمل الرقم نفسه. اختر الملف الصحيح بعد التحقق من المريض.",
  BOOKING_PATIENT_MISMATCH: "الملف المختار لا يطابق طلب المريض. حدّث المراجعة.",
  BOOKING_CASE_REQUIRED: "اختر حالة متابعة واحدة لها طبيب مسؤول معتمد. لا يمكن تخمين المسؤول.",
  BOOKING_RESPONSIBLE_CHANGED: "الطبيب المختار يختلف عن مسؤول الحالة الحالي. حدّث الحالة والطبيب قبل التأكيد.",
  BOOKING_DOCTOR_DUTY: "الوقت خارج جدول الطبيب أو إجازاته، أو لم يُتحقق من جدوله. اختر وقتًا متاحًا.",
  BOOKING_DOCTOR_INVALID: "اختر طبيبًا متاحًا للحجز.",
  BOOKING_SERVICE_INVALID: "الخدمة غير متاحة. حدّث الطلب واختر خدمة فعّالة.",
  BOOKING_ALREADY_CHANGED: "الطلب عولج أو تغير الموعد. حدّث القائمة قبل المحاولة.",
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return json("انتهت الجلسة.", 401);
  if (session.role !== "admin" && session.role !== "reception") return json("مراجعة الطلبات للاستقبال والإدارة.", 403);
  const id = positiveId((await context.params).id);
  if (!id) return json("رقم الطلب غير صالح.", 400);
  try {
    const candidates = await bookingRequestPatientChoices(id);
    const query = new URL(request.url).searchParams;
    const patientId = query.has("patientId") ? positiveId(query.get("patientId")) : candidates.length === 1 ? candidates[0].id : null;
    if (patientId !== null && !candidates.some(row => row.id === patientId)) return json("الملف لا يطابق الطلب.", 400);
    const date = query.get("date") ?? clinicDateString(new Date(), CLINIC_TIME_ZONE);
    if (!dateValid(date)) return json("تاريخ غير صالح.", 400);
    const cases = patientId ? (await getPool().query(`SELECT c.id,c.title,c.specialty,c.responsible_party_id AS "doctorId",p.name AS "doctorName"
      FROM clinical_cases c LEFT JOIN parties p ON p.id=c.responsible_party_id
      WHERE c.patient_id=$1 AND c.status IN ('active','waiting') ORDER BY c.id`, [patientId])).rows : [];
    const nearby = patientId ? (await getPool().query(`SELECT id,scheduled_date::text AS date,scheduled_time::text AS time,status
      FROM appointments WHERE patient_id=$1 AND scheduled_date BETWEEN $2::date-2 AND $2::date+2
      AND status NOT IN ('cancelled','no_show') ORDER BY scheduled_date,scheduled_time`, [patientId, date])).rows : [];
    return NextResponse.json({ candidates, patientId, cases, nearby }, { headers: { "Cache-Control": "no-store" } });
  } catch { return json("تعذّر تحميل مراجعة الطلب.", 503); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return json("انتهت الجلسة. سجّل الدخول من جديد.", 401);
  if (session.role !== "admin" && session.role !== "reception") return json("إدارة طلبات الحجز للاستقبال والإدارة.", 403);
  const id = positiveId((await context.params).id);
  if (!id) return json("رقم الطلب غير صالح.", 400);
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); }
  catch (error) { return bodyErrorResponse(error) ?? json("طلب غير صالح.", 400); }
  const source = (body ?? {}) as Record<string, unknown>;
  try {
    if (source.action === "reject") {
      const rejected = await rejectBookingRequest(id);
      return rejected ? NextResponse.json(rejected) : json("الطلب عولج سلفًا.", 409);
    }
    if (source.action !== "confirm") return json("إجراء غير معروف.", 400);
    const date = typeof source.date === "string" ? source.date : "";
    const time = typeof source.time === "string" ? source.time : "";
    if (!dateValid(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return json("تاريخ أو وقت غير صالح.", 400);
    const durationMinutes = Number(source.durationMinutes ?? 30);
    if (!Number.isInteger(durationMinutes) || durationMinutes < MIN_DURATION || durationMinutes > MAX_DURATION) return json("مدة الموعد غير صالحة.", 400);
    const draft = await getBookingRequest(id);
    if (!draft) return json("الطلب غير موجود.", 404);
    const serviceId = positiveId(source.serviceId) ?? draft.preferences?.serviceId ?? null;
    let service = await resolveService({ serviceId });
    let doctorId = positiveId(source.doctorId) ?? draft.preferences?.doctorId ?? null;
    let patientId: number | null = null;
    const chairNo = positiveId(source.chairNo);
    const actorUser = await findUserByUsername(session.username).catch(() => null);
    const canOverride = actorCanOverride({ username: session.username, role: session.role, channel: "ui",
      canOverrideCapacity: actorUser?.permissions?.canOverrideCapacity === true });
    const overrideReason = typeof source.overrideReason === "string" ? source.overrideReason.trim().slice(0, 300) : "";
    const state: { verdict: CapacityVerdict | null; replay: Awaited<ReturnType<typeof getAppointment>> } = { verdict: null, replay: null };
    const result = await writeAppointmentInDay({ date,
      judge: async (sameDay, client) => {
        const current = await getBookingRequest(id, client);
        if (!current) throw new Error("BOOKING_ALREADY_CHANGED");
        if (current.status === "confirmed" && current.appointmentId) {
          // Replays return the persisted appointment, including a later staff reschedule.
          state.replay = await getAppointment(current.appointmentId, client);
          if (!state.replay) throw new Error("BOOKING_ALREADY_CHANGED");
          return { ok: true as const };
        }
        if (current.status !== "new") throw new Error("BOOKING_ALREADY_CHANGED");
        const now = new Date();
        const today = clinicDateString(now, CLINIC_TIME_ZONE);
        const clock = new Intl.DateTimeFormat("en-GB", { timeZone: CLINIC_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
        if (date < today || (date === today && time <= clock)) throw new Error("BOOKING_DOCTOR_DUTY");
        // Fresh settings and catalogue, held through the write; cached page data is advisory.
        await client.query("LOCK TABLE settings IN SHARE MODE");
        const capacityContext = await loadCapacityContext(await getSettingsInTransaction(client));
        if (chairNo !== null && chairNo > capacityContext.chairs) throw new Error("BOOKING_SERVICE_INVALID");
        if (serviceId) service = await lockAppointmentServiceForBooking(client, serviceId);
        if (!service || !service.isActive) throw new Error("BOOKING_SERVICE_INVALID");
        patientId = await existingPatientForBookingRequest(id, client, positiveId(source.patientId));
        doctorId = await bookingRequestDoctor(client, { patientId, caseId: positiveId(source.caseId), doctorId,
          followUp: service.legacyType === "follow_up" || source.appointmentType === "follow_up" });
        if (!doctorId || !await lockBookableAppointmentDoctor(client, doctorId)) throw new Error("BOOKING_DOCTOR_INVALID");
        await assertBookingRequestDuty(client, { doctorId, date, time, durationMinutes,
          before: service.bufferBeforeMinutes, after: service.bufferAfterMinutes });
        const judged = await judgeBookingInDay({ sameDay, client, date, time, durationMinutes,
          service: { ...service, requiresProvider: true, allowsConcurrentProviderWork: false },
          context: capacityContext, providerId: doctorId, chairNo, patientId, isNewPatient: patientId === null,
          // A patient-facing promise cannot override a doctor/chair collision.
          canOverride: false, overrideReason: canOverride ? overrideReason : "" });
        if (!judged.ok) return { ok: false as const, conflict: judged.conflict };
        if (judged.overridden) state.verdict = judged.verdict;
        return { ok: true as const };
      },
      commit: async client => {
        if (state.replay) return { appointmentId: state.replay.id, patientId: state.replay.patientId };
        return confirmBookingRequest({ id, date, time, durationMinutes, patientId, doctorId,
          serviceId: service!.id, appointmentType: service!.legacyType, chairNo,
          bufferBeforeMinutes: service!.bufferBeforeMinutes, bufferAfterMinutes: service!.bufferAfterMinutes,
          occupiesChair: service!.requiresChair }, client);
      },
    });
    if (!result.ok) return NextResponse.json(result.conflict, { status: 409 });
    if (!result.value) return json("الطلب عولج سلفًا.", 409);
    const appointment = state.replay ?? await getAppointment(result.value.appointmentId);
    if (state.verdict) await recordCapacityOverride({ appointmentId: result.value.appointmentId,
      verdict: state.verdict, date, time, reason: overrideReason, serviceName: service?.nameAr,
      actor: session.username, actorRole: session.role, channel: "ui" });
    return NextResponse.json({ ...result.value, replayed: state.replay !== null,
      scheduledDate: appointment?.scheduledDate, scheduledTime: appointment?.scheduledTime,
      durationMinutes: appointment?.durationMinutes, doctorId: appointment?.doctorId, status: appointment?.status },
      { status: state.replay ? 200 : 201 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return json(errors[code] ?? "تعذّر تنفيذ الإجراء. أعد المحاولة بالمحاولة نفسها.", errors[code] ? 409 : 503);
  }
}

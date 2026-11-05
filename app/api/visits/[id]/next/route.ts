import { readReturnBookingContext } from "@/lib/return-booking-context";
import { parseReturnBookingSource } from "@/lib/return-booking-source";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { createNextSession, prepareNextSessionPatient, findUserByUsername, getClinicalVisit, writeAppointmentInDay } from "@/lib/db";
import { loadCapacityContext, resolveService } from "@/lib/capacity-context";
import type { CapacityVerdict } from "@/lib/capacity";
import { actorCanOverride, judgeBookingInDay, recordCapacityOverride } from "@/lib/book-appointment";
import { toWhatsAppNumber } from "@/lib/reminders";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * حجز الجلسة القادمة للمريض الذي انتهت زيارته للتو.
 *
 * مسار مستقل عن `POST /api/appointments` لأن مدخله مختلف: هناك يُختار مريض من سجل
 * قائم، وهنا يُشتقّ من زيارة قد تكون لمريض مشى لا سجلّ له بعد. وما يجمعهما — حارس
 * السعة — يمرّ منه الاثنان.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const visitId = Number(rawId);
  if (!Number.isInteger(visitId) || visitId <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }

  const visit = await getClinicalVisit(visitId);
  if (!visit) {
    return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
  }
  if (visit.patientId !== null && !(await canAccessPatient(session, visit.patientId))) {
    return NextResponse.json({ message: "غير مصرّح لك بجدولة جلسة لهذا المريض." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  const durationMinutes = Number(source.durationMinutes ?? 30);
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;

  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }

  // رقم مكتوب في الحقل يُقبل فقط إن صلح للاتصال؛ ورقم فارغ يعني الاكتفاء برقم الزيارة.
  let phone: string | null = null;
  if (typeof source.phone === "string" && source.phone.trim()) {
    phone = toWhatsAppNumber(source.phone);
    if (!phone) {
      return NextResponse.json({ message: "رقم الجوال غير صحيح. اتركه فارغًا أو صحّحه." }, { status: 400 });
    }
  }

  try {
    /* محرّك السعة نفسه وقفل اليوم نفسه: الجلسة القادمة حجزٌ يُحسب في السعة، فلا
       تفلت من الحكم ولا من القفل. */
    const capacityContext = await loadCapacityContext();
    const service = await resolveService({
      serviceId: Number(source.serviceId) > 0 ? Number(source.serviceId) : null,
      appointmentType: typeof source.appointmentType === "string" ? source.appointmentType : null,
    });
    const actorUser = await findUserByUsername(session.username).catch(() => null);
    const canOverride = actorCanOverride({
      username: session.username, role: session.role, channel: "visit",
      canOverrideCapacity: actorUser?.permissions?.canOverrideCapacity === true,
    });
    const overrideReason = typeof source.overrideReason === "string"
      ? source.overrideReason.trim().slice(0, 300) : "";
    /* التجاوز يُلتقط هنا ليُسجَّل بعد نجاح الكتابة — لا يُهمل كما كان. */
    const overrideState: { verdict: CapacityVerdict | null; doctorId: number | null; doctorName: string | null; refusal: { status: number; message: string; code?: string } | null } = { verdict: null, doctorId: null, doctorName: null, refusal: null };
    const result = await writeAppointmentInDay({
      date,
      judge: async (sameDay, client) => {
        // Resolve the actual patient before admission, on the same transaction
        // that writes the appointment. Walk-ins can match an existing phone.
        const patientId = await prepareNextSessionPatient(client, { visitId, phone });
        if (patientId === null) {
          overrideState.refusal = { status: 404, message: "الزيارة غير موجودة." };
          return { ok: false as const, conflict: null };
        }
        if (!await canAccessPatient(session, patientId, undefined, client, "nowait")) {
          overrideState.refusal = { status: 403, message: "غير مصرّح لك بجدولة جلسة لهذا المريض." };
          return { ok: false as const, conflict: null };
        }
        if (typeof source.returnBookingFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(source.returnBookingFingerprint)) {
          overrideState.refusal = { status: 409, code: "return_booking_context_required", message: "تحقّق من سياق العودة والطبيب المسؤول قبل الحجز." };
          return { ok: false as const, conflict: null };
        }
        const origin = { kind: "visit" as const, id: visitId };
        const selected = source.returnBookingSource === undefined ? origin : parseReturnBookingSource(source.returnBookingSource);
        if (!selected) {
          overrideState.refusal = { status: 400, code: "return_booking_source_invalid", message: "اختر الحالة المرتبطة بهذه الزيارة." };
          return { ok: false as const, conflict: null };
        }
        const responsible = await readReturnBookingContext(client, patientId, selected, { lock: true, origin });
        if (!responsible.ok) {
          overrideState.refusal = { status: 409, code: responsible.code, message: responsible.message };
          return { ok: false as const, conflict: null };
        }
        if (source.returnBookingFingerprint !== undefined && source.returnBookingFingerprint !== responsible.fingerprint) {
          overrideState.refusal = { status: 409, code: "return_booking_source_changed", message: "تغيّر الطبيب المسؤول. حدّث اقتراح الحجز وراجعه قبل التأكيد." };
          return { ok: false as const, conflict: null };
        }
        overrideState.doctorId = responsible.doctorId;
        overrideState.doctorName = responsible.doctorName;
        const judged = await judgeBookingInDay({
          sameDay, client, date, time, durationMinutes, service,
          context: capacityContext, canOverride, overrideReason, providerId: responsible.doctorId, requireAssignedProvider: true,
          nearbyAppointmentConfirmation: typeof source.nearbyAppointmentConfirmation === "string" ? source.nearbyAppointmentConfirmation.slice(0, 4096) : null,
          bookingActor: `${session.userId}:${session.username}`, bookingScope: JSON.stringify({ entry: "next-visit", visitId, phone, note, source: selected, fingerprint: responsible.fingerprint }),
          patientId,
        });
        if (!judged.ok) return { ok: false as const, conflict: judged.conflict };
        if (judged.overridden) overrideState.verdict = judged.verdict;
        return { ok: true as const };
      },
      commit: (client) =>
        createNextSession({ visitId, date, time, durationMinutes, phone, note, doctorId: overrideState.doctorId }, client),
    });
    if (!result.ok) {
      if (overrideState.refusal) return NextResponse.json({ message: overrideState.refusal.message, ...(overrideState.refusal.code ? { code: overrideState.refusal.code } : {}) }, { status: overrideState.refusal.status });
      return NextResponse.json(result.conflict, { status: 409 });
    }
    const created = result.value;
    if (!created) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    }
    if (overrideState.verdict) {
      await recordCapacityOverride({
        appointmentId: (created as { appointmentId?: number; id?: number }).appointmentId
          ?? (created as { id?: number }).id ?? visitId,
        verdict: overrideState.verdict, date, time, reason: overrideReason,
        serviceName: service?.nameAr, actor: session.username,
        actorRole: session.role, channel: "visit",
      });
    }
    return NextResponse.json({ ...created, doctorId: overrideState.doctorId, doctorName: overrideState.doctorName }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") {
      return NextResponse.json({ code: "return_booking_source_changed", message: "يجري تحديث ملف المريض. أعد المحاولة بعد لحظة." }, { status: 409 });
    }
    return NextResponse.json({ message: "تعذّر حجز الجلسة. أعد المحاولة." }, { status: 500 });
  }
}

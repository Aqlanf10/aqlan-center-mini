import { readReturnBookingContext } from "@/lib/return-booking-context";
import { parseReturnBookingSource } from "@/lib/return-booking-source";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { ensureSchema, findUserByUsername, getPool, schedulePlannedVisit } from "@/lib/db";
import { loadCapacityContext, resolveService } from "@/lib/capacity-context";
import type { CapacityVerdict } from "@/lib/capacity";
import { actorCanOverride, judgeBookingInDay, recordCapacityOverride } from "@/lib/book-appointment";
import { requireSession } from "@/lib/session";
import { canAccessPatient } from "@/lib/patient-access";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

/**
 * تحويل الزيارة المخطَّطة موعدًا — بتاريخٍ ووقت فقط (المواصفة §١١).
 *
 * سبب الموعد والعلاج والمدة والطبيب كلها في الزيارة المخطَّطة أصلًا؛ إعادة إدخالها
 * موعدًا مستقلًّا هو ما يجعل الاتفاق يُكتب مرتين فيخالف إحداهما الأخرى يوم الخلاف.
 * والكتابة تمرّ من قفل اليوم الذرّي نفسه الذي يمرّ عليه كل حجز.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  const { id } = await context.params;
  const plannedVisitId = Number(id);
  if (!Number.isInteger(plannedVisitId) || plannedVisitId <= 0) {
    return NextResponse.json({ message: "رقم الزيارة المخطَّطة غير صالح." }, { status: 400 });
  }

  await ensureSchema();
  const { rows } = await getPool().query<{ patient_id: number }>(
    "SELECT patient_id FROM planned_visits WHERE id = $1",
    [plannedVisitId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ message: "الزيارة المخطَّطة غير موجودة." }, { status: 404 });
  }
  if (!(await canAccessPatient(session, rows[0].patient_id))) {
    return NextResponse.json({ message: "غير مصرّح لك بجدولة جلسة لهذا المريض." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "التاريخ غير صالح." }, { status: 400 });
  }
  if (!TIME_PATTERN.test(time)) {
    return NextResponse.json({ message: "الوقت غير صالح." }, { status: 400 });
  }

  try {
    /* محرّك السعة نفسه — يُحقن من هنا لأن استدعاءه داخل `db` يصنع دورة استيراد.
       والمدّة تأتي من الزيارة المخطَّطة نفسها لا من هذا المسار. */
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
    const overrideState: { verdict: CapacityVerdict | null; doctorId: number | null; doctorName: string | null } = { verdict: null, doctorId: null, doctorName: null };
    const result = await schedulePlannedVisit({
      plannedVisitId, date, time, chairs: capacityContext.chairs,
      judge: async (day, client, durationMinutes) => {
        if (typeof source.returnBookingFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(source.returnBookingFingerprint)) {
          return { ok: false, conflict: { code: "return_booking_context_required", message: "تحقّق من سياق العودة والطبيب المسؤول قبل الحجز." } };
        }
        const origin = { kind: "planned_visit" as const, id: plannedVisitId };
        const selected = source.returnBookingSource === undefined ? origin : parseReturnBookingSource(source.returnBookingSource);
        if (!selected) return { ok: false, conflict: { code: "return_booking_source_invalid", message: "اختر الحالة المرتبطة بهذه الجلسة." } };
        const responsible = await readReturnBookingContext(client, rows[0].patient_id, selected, { lock: true, origin });
        if (!responsible.ok) return { ok: false, conflict: { code: responsible.code, message: responsible.message } };
        if (source.returnBookingFingerprint !== undefined && source.returnBookingFingerprint !== responsible.fingerprint) {
          return { ok: false, conflict: { code: "return_booking_source_changed", message: "تغيّر الطبيب المسؤول. حدّث اقتراح الحجز وراجعه قبل التأكيد." } };
        }
        overrideState.doctorId = responsible.doctorId;
        overrideState.doctorName = responsible.doctorName;
        const judged = await judgeBookingInDay({
          sameDay: day, client, date, time, durationMinutes, service,
          context: capacityContext, canOverride, overrideReason, providerId: responsible.doctorId, requireAssignedProvider: true,
          nearbyAppointmentConfirmation: typeof source.nearbyAppointmentConfirmation === "string" ? source.nearbyAppointmentConfirmation.slice(0, 4096) : null,
          bookingActor: `${session.userId}:${session.username}`, bookingScope: JSON.stringify({ entry: "planned-schedule", plannedVisitId, source: selected, fingerprint: responsible.fingerprint }),
          patientId: rows[0].patient_id,
        });
        if (!judged.ok) return { ok: false, conflict: judged.conflict };
        if (judged.overridden) overrideState.verdict = judged.verdict;
        return { ok: true, doctorId: responsible.doctorId };
      },
    });

    if (result.ok) {
      if (overrideState.verdict) {
        await recordCapacityOverride({
          appointmentId: result.appointmentId, verdict: overrideState.verdict,
          date, time, reason: overrideReason, serviceName: service?.nameAr,
          actor: session.username, actorRole: session.role, channel: "visit",
        });
      }
      return NextResponse.json(
        { appointmentId: result.appointmentId, title: result.title, doctorId: overrideState.doctorId, doctorName: overrideState.doctorName }, { status: 201 },
      );
    }
    if (result.reason === "conflict") {
      return NextResponse.json(result.conflict, { status: 409 });
    }
    const messages: Record<string, string> = {
      not_found: "الزيارة المخطَّطة غير موجودة.",
      not_schedulable: "هذه الزيارة المخطَّطة منجَزة أو ملغاة.",
      already_scheduled: "الزيارة المخطَّطة محوَّلة موعدًا سلفًا.",
    };
    return NextResponse.json(
      { message: messages[result.reason] ?? "تعذّر جدولة الجلسة." },
      { status: 409 },
    );
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return NextResponse.json({ code: "return_booking_source_changed", message: "يجري تحديث المسؤول عن الحالة. حدّث الاقتراح وأعد المحاولة." }, { status: 409 });
    return NextResponse.json({ message: "تعذّر حجز الجلسة. أعد المحاولة." }, { status: 500 });
  }
}

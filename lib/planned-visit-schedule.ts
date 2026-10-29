import { NextResponse } from "next/server";
import { readReturnBookingContext } from "./return-booking-context";
import { parseReturnBookingSource } from "./return-booking-source";
import { schedulePlannedVisit, type AuditInput, type DbClient } from "./db";
import { loadCapacityContext, resolveService } from "./capacity-context";
import type { CapacityVerdict } from "./capacity";
import { actorCanOverride, judgeBookingInDay, recordCapacityOverride, type BookingActor } from "./book-appointment";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

export type PlannedVisitScheduleResult =
  | { ok: true; appointmentId: number; title: string; doctorId: number | null; doctorName: string | null }
  | { ok: false; kind: "invalid"; message: string }
  | { ok: false; kind: "conflict"; conflict: unknown }
  | { ok: false; kind: "rejected"; reason: string };

/**
 * تحويل الزيارة المخطَّطة موعدًا عبر محرّك السعة — الباب نفسه للمسارين (القديم،
 * والموحّد في M2 slice 22).
 *
 * محرّك السعة نفسه — يُحقن من هنا لأن استدعاءه داخل `db` يصنع دورة استيراد. والمدّة
 * تأتي من الزيارة المخطَّطة نفسها لا من هذا المسار. With `options.client` (the
 * canonical admitted transaction) the preview, day locks, judgement and write run on
 * it and `options.audit` writes the override row atomically; without options: the
 * legacy path, unchanged.
 */
export async function schedulePlannedVisitThroughEngine(
  plannedVisitId: number, patientId: number, source: Record<string, unknown>, actor: BookingActor & { userId: number },
  options: { client?: DbClient; audit?: (row: AuditInput) => Promise<void> } = {},
): Promise<PlannedVisitScheduleResult> {
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  if (!DATE_PATTERN.test(date)) return { ok: false, kind: "invalid", message: "التاريخ غير صالح." };
  if (!TIME_PATTERN.test(time)) return { ok: false, kind: "invalid", message: "الوقت غير صالح." };
  const capacityContext = await loadCapacityContext();
  const service = await resolveService({
    serviceId: Number(source.serviceId) > 0 ? Number(source.serviceId) : null,
    appointmentType: typeof source.appointmentType === "string" ? source.appointmentType : null,
  });
  const canOverride = actorCanOverride(actor);
  const overrideReason = typeof source.overrideReason === "string"
    ? source.overrideReason.trim().slice(0, 300) : "";
  /* التجاوز يُلتقط هنا ليُسجَّل بعد نجاح الكتابة — لا يُهمل كما كان. */
  const overrideState: { verdict: CapacityVerdict | null; doctorId: number | null; doctorName: string | null } = { verdict: null, doctorId: null, doctorName: null };
  const result = await schedulePlannedVisit({
    client: options.client,
    plannedVisitId, date, time, chairs: capacityContext.chairs,
    judge: async (day, client, durationMinutes) => {
      if (typeof source.returnBookingFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(source.returnBookingFingerprint)) {
        return { ok: false, conflict: { code: "return_booking_context_required", message: "تحقّق من سياق العودة والطبيب المسؤول قبل الحجز." } };
      }
      const origin = { kind: "planned_visit" as const, id: plannedVisitId };
      const selected = source.returnBookingSource === undefined ? origin : parseReturnBookingSource(source.returnBookingSource);
      if (!selected) return { ok: false, conflict: { code: "return_booking_source_invalid", message: "اختر الحالة المرتبطة بهذه الجلسة." } };
      const responsible = await readReturnBookingContext(client, patientId, selected, { lock: true, origin });
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
        bookingActor: `${actor.userId}:${actor.username}`, bookingScope: JSON.stringify({ entry: "planned-schedule", plannedVisitId, source: selected, fingerprint: responsible.fingerprint }),
        patientId,
      });
      if (!judged.ok) return { ok: false, conflict: judged.conflict };
      if (judged.overridden) overrideState.verdict = judged.verdict;
      return { ok: true, doctorId: responsible.doctorId };
    },
  });
  if (!result.ok) return result.reason === "conflict" ? { ok: false, kind: "conflict", conflict: result.conflict } : { ok: false, kind: "rejected", reason: result.reason };
  if (overrideState.verdict) {
    await recordCapacityOverride({
      appointmentId: result.appointmentId, verdict: overrideState.verdict,
      date, time, reason: overrideReason, serviceName: service?.nameAr,
      actor: actor.username, actorRole: (actor.role ?? null) as string | null, channel: "visit",
    }, options.audit);
  }
  return { ok: true, appointmentId: result.appointmentId, title: result.title, doctorId: overrideState.doctorId, doctorName: overrideState.doctorName };
}

const REJECTED: Record<string, string> = {
  not_found: "الزيارة المخطَّطة غير موجودة.",
  not_schedulable: "هذه الزيارة المخطَّطة منجَزة أو ملغاة.",
  already_scheduled: "الزيارة المخطَّطة محوَّلة موعدًا سلفًا.",
};

/** The legacy response shapes. */
export function plannedVisitScheduleResponse(result: PlannedVisitScheduleResult, headers?: HeadersInit): NextResponse {
  if (result.ok) return NextResponse.json({ appointmentId: result.appointmentId, title: result.title, doctorId: result.doctorId, doctorName: result.doctorName }, { status: 201, headers });
  if (result.kind === "invalid") return NextResponse.json({ message: result.message }, { status: 400, headers });
  if (result.kind === "conflict") return NextResponse.json(result.conflict, { status: 409, headers });
  return NextResponse.json({ message: REJECTED[result.reason] ?? "تعذّر جدولة الجلسة." }, { status: 409, headers });
}

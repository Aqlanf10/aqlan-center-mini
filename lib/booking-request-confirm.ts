import { NextResponse } from "next/server";
import { readReturnBookingContext } from "./return-booking-context";
import { parseReturnBookingSource } from "./return-booking-source";
import { confirmBookingRequest, existingPatientForBookingRequest, writeAppointmentInDay, type AuditInput, type DbClient } from "./db";
import { loadCapacityContext, resolveService } from "./capacity-context";
import type { CapacityVerdict } from "./capacity";
import { actorCanOverride, judgeBookingInDay, recordCapacityOverride, type BookingActor } from "./book-appointment";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ConfirmResult =
  | { ok: true; confirmed: { appointmentId: number; patientId: number }; isReturn: boolean; doctorId: number | null; doctorName: string | null }
  | { ok: false; kind: "invalid"; message: string }
  | { ok: false; kind: "conflict"; conflict: unknown }
  | { ok: false; kind: "handled" }
  | { ok: false; kind: "patient_create_required" };

/**
 * تأكيدُ الطلب عبر محرّك السعة — الباب نفسه للمسارين (القديم، والموحّد في M2 slice 21).
 *
 * محرّك السعة نفسه الذي يحمي الحجز اليدوي: تأكيد الطلب حجزٌ كامل، ولو حكم بقاعدةٍ
 * أخفَّ لدخل من الباب الخلفي ما مُنع من الأمامي. والحكم والكتابة معًا داخل قفل
 * اليوم الذرّي — فلا يفلت تأكيدٌ متزامن من فحصٍ قرأ قبل كتابة غيره.
 *
 * With `options.client` (the canonical admitted transaction) the day locks, judgement
 * and confirmation run on it and `options.audit` writes the override row atomically;
 * `allowNewPatient: false` refuses a request whose phone matches no patient (creating
 * a patient is its own grant on the canonical path). Without options: the legacy path.
 */
export async function confirmBookingRequestThroughEngine(
  id: number, source: Record<string, unknown>, actor: BookingActor & { userId: number },
  options: { client?: DbClient; audit?: (row: AuditInput) => Promise<void>; allowNewPatient?: boolean } = {},
): Promise<ConfirmResult> {
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  const durationMinutes = Number(source.durationMinutes ?? 30);
  if (!DATE_PATTERN.test(date)) return { ok: false, kind: "invalid", message: "تاريخ غير صالح." };

  const capacityContext = await loadCapacityContext();
  const service = await resolveService({
    serviceId: Number(source.serviceId) > 0 ? Number(source.serviceId) : null,
    appointmentType: typeof source.appointmentType === "string" ? source.appointmentType : null,
  });
  const canOverride = actorCanOverride(actor);
  const overrideReason = typeof source.overrideReason === "string"
    ? source.overrideReason.trim().slice(0, 300) : "";
  /* التجاوز يُلتقط هنا ليُسجَّل بعد نجاح الكتابة — لا يُهمل كما كان. */
  const isReturn = source.appointmentType === "follow_up" || service?.legacyType === "follow_up" || source.returnBookingSource != null;
  const overrideState: { verdict: CapacityVerdict | null; doctorId: number | null; doctorName: string | null; patientId: number | null; newPatientRefused: boolean } =
    { verdict: null, doctorId: null, doctorName: null, patientId: null, newPatientRefused: false };
  const result = await writeAppointmentInDay({
    client: options.client,
    date,
    judge: async (sameDay, client) => {
      // Lock the request before resolving its phone-matched patient; the
      // commit verifies that same patient rather than switching ownership.
      const patientId = await existingPatientForBookingRequest(id, client);
      overrideState.patientId = patientId;
      if (patientId === null && options.allowNewPatient === false) {
        overrideState.newPatientRefused = true;
        return { ok: false as const, conflict: null };
      }
      let scope = `booking-request:${id}`;
      if (isReturn) {
        const selected = parseReturnBookingSource(source.returnBookingSource);
        if (!patientId || !selected || typeof source.returnBookingFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(source.returnBookingFingerprint)) {
          return { ok: false as const, conflict: { code: "return_booking_context_required", message: "سجّل المريض واختر سياق العودة وطبيبه المسؤول قبل تأكيد موعد المراجعة." } };
        }
        const responsible = await readReturnBookingContext(client, patientId, selected, { lock: true });
        if (!responsible.ok) return { ok: false as const, conflict: { code: responsible.code, message: responsible.message } };
        if (source.returnBookingFingerprint !== responsible.fingerprint) return { ok: false as const, conflict: { code: "return_booking_source_changed", message: "تغيّر الطبيب المسؤول. حدّث اقتراح العودة قبل التأكيد." } };
        overrideState.doctorId = responsible.doctorId;
        overrideState.doctorName = responsible.doctorName;
        scope = JSON.stringify({ entry: "booking-request", id, source: selected, fingerprint: responsible.fingerprint });
      }
      const judged = await judgeBookingInDay({
        sameDay, client, date, time, durationMinutes, service,
        context: capacityContext, canOverride, overrideReason, providerId: overrideState.doctorId, requireAssignedProvider: isReturn,
        nearbyAppointmentConfirmation: typeof source.nearbyAppointmentConfirmation === "string" ? source.nearbyAppointmentConfirmation.slice(0, 4096) : null,
        bookingActor: `${actor.userId}:${actor.username}`, bookingScope: scope,
        // (P2-3) مريضٌ قائم بهاتف الطلب لا يُحجز فوق موعده.
        patientId,
      });
      if (!judged.ok) return { ok: false as const, conflict: judged.conflict };
      if (judged.overridden) overrideState.verdict = judged.verdict;
      return { ok: true as const };
    },
    commit: (client) => confirmBookingRequest({ id, date, time, durationMinutes, doctorId: overrideState.doctorId, expectedPatientId: overrideState.patientId }, client),
  });
  if (!result.ok) return overrideState.newPatientRefused ? { ok: false, kind: "patient_create_required" } : { ok: false, kind: "conflict", conflict: result.conflict };
  const confirmed = result.value;
  if (!confirmed) return { ok: false, kind: "handled" };
  if (overrideState.verdict) {
    await recordCapacityOverride({
      appointmentId: (confirmed as { appointmentId?: number; id?: number }).appointmentId
        ?? (confirmed as { id?: number }).id ?? id,
      verdict: overrideState.verdict, date, time, reason: overrideReason,
      serviceName: service?.nameAr, actor: actor.username,
      actorRole: (actor.role ?? null) as string | null, channel: "ui",
    }, options.audit);
  }
  return { ok: true, confirmed, isReturn, doctorId: overrideState.doctorId, doctorName: overrideState.doctorName };
}

/** The legacy response shapes (the canonical branch maps the canonical refusals first). */
export function confirmBookingRequestResponse(result: ConfirmResult, headers?: HeadersInit): NextResponse {
  if (!result.ok) {
    if (result.kind === "invalid") return NextResponse.json({ message: result.message }, { status: 400, headers });
    if (result.kind === "conflict") return NextResponse.json(result.conflict, { status: 409, headers });
    if (result.kind === "patient_create_required") return NextResponse.json({ code: "patient_create_required", message: "صاحب الطلب ليس مريضًا مسجّلًا، وإنشاء ملف مريضٍ جديد يحتاج صلاحية «إضافة مريض»." }, { status: 403, headers });
    return NextResponse.json({ message: "الطلب عولج سلفًا." }, { status: 409, headers });
  }
  return NextResponse.json(result.isReturn ? { ...result.confirmed, doctorId: result.doctorId, doctorName: result.doctorName } : result.confirmed, { status: 201, headers });
}

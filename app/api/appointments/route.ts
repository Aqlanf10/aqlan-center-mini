import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE, doctorOwnedPatientIds, findUserByUsername, labWorkForPatients, listAppointmentsByDate,
} from "@/lib/db";
import { labReadinessFor, type LabReadinessItem } from "@/lib/lab-readiness";
import { clinicDateString, type Appointment } from "@/lib/schedule";
import type { ReturnBookingSource } from "@/lib/return-booking-context";
import { bookAppointment } from "@/lib/book-appointment";
import { canAccessPatient } from "@/lib/patient-access";
import { requireSession } from "@/lib/session";
import { selectRequestStaffEnvelope } from "@/lib/staff-session-admission";
import { NO_STORE, canonicalWaitingFailure } from "@/lib/canonical-patient-http";
import { CanonicalAppointmentRefusal, CanonicalBookingConflict, commandCanonicalBooking, parseCanonicalBooking, readCanonicalAppointmentDay } from "@/lib/canonical-appointments";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Keep the existing array contract while carrying the canonical display zone. */
const appointmentListResponse = (list: Appointment[]) => NextResponse.json(list, {
  headers: { "X-Clinic-Time-Zone": CLINIC_TIME_ZONE },
});

/**
 * جاهزية أعمال المختبر بجانب كل موعد — «هل وصلت التركيبة؟» (lib/lab-readiness.ts).
 *
 * إضافةٌ لا تكسر القائمة: فشل استعلام المختبر يُرجع المواعيد بلا الحقل، فقائمة
 * اليوم لا تسقط أبدًا بسبب معلومةٍ مساعدة. وتُحسب بعد فلترة الطبيب فلا تكشف
 * أعمال مريضٍ لا يراه.
 */
async function withLabReadiness(list: Appointment[], date: string): Promise<(Appointment & { labReadiness?: LabReadinessItem[] })[]> {
  const works = await labWorkForPatients(list.map((appointment) => appointment.patientId)).catch(() => null);
  if (!works || works.length === 0) return list;
  const today = clinicDateString(new Date(), CLINIC_TIME_ZONE);
  return list.map((appointment) => {
    const own = works.filter((work) => work.patientId === appointment.patientId);
    return own.length === 0 ? appointment : { ...appointment, labReadiness: labReadinessFor(own, date, today) };
  });
}

export async function GET(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    // Canonical identity (M2 slice 15): one day inside the appointment scope; lab
    // readiness with the operational summary.
    try {
      return NextResponse.json(await readCanonicalAppointmentDay(selected.handle, new URL(request.url).searchParams.get("date") ?? ""),
        { headers: { ...NO_STORE, "X-Clinic-Time-Zone": CLINIC_TIME_ZONE } });
    } catch (error) {
      return canonicalWaitingFailure(error, "تعذّر تحميل مواعيد اليوم.");
    }
  }
  const session = await requireSession();
  if (!session) return denied();
  const date = new URL(request.url).searchParams.get("date") ?? "";
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }
  try {
    const list = await listAppointmentsByDate(date);
    /* صلاحيات الوكيل المساعد: الطبيب بلا منحٍ صريح يرى مواعيده ومواعيد مرضاه
       والمواعيد غير المسندة — لا جدول زملائه. الفلترة في الخادم بعد الجلب
       (قائمة يوم كامل بضع عشرات صفوف) لا في الشاشة. */
    if (session.role === "doctor") {
      const user = await findUserByUsername(session.username).catch(() => null);
      if (!user?.permissions?.canViewAllAppointments) {
        const doctorPartyId = user?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null);
        if (doctorPartyId) {
          const candidateIds = Array.from(new Set(list.map((a) => a.patientId)));
          const owned = await doctorOwnedPatientIds(doctorPartyId, candidateIds).catch(() => new Set<number>());
          return appointmentListResponse(await withLabReadiness(
            list.filter((a) => !a.doctorId || a.doctorId === doctorPartyId || owned.has(a.patientId)),
            date,
          ));
        }
        return appointmentListResponse([]);
      }
    }
    return appointmentListResponse(await withLabReadiness(list, date));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل مواعيد اليوم." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const selected = await selectRequestStaffEnvelope();
  if (selected.kind === "denied") return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401, headers: NO_STORE });
  if (selected.kind === "canonical") {
    // Canonical identity (M2 slice 16): one admitted appointments.create transaction
    // through the same capacity engine; refusals answer as below.
    let canonicalBody: unknown;
    try { canonicalBody = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; return NextResponse.json({ code: "invalid_booking_input", message: "طلب غير صالح." }, { status: 400, headers: NO_STORE }); }
    try {
      const result = await commandCanonicalBooking(selected.handle, parseCanonicalBooking(canonicalBody));
      return NextResponse.json(result.warning ? { ...result.appointment, warning: result.warning } : result.appointment, { status: 201, headers: NO_STORE });
    } catch (error) {
      if (error instanceof CanonicalBookingConflict) return NextResponse.json(error.conflict, { status: 409, headers: NO_STORE });
      if (error instanceof CanonicalAppointmentRefusal && error.engineCode) {
        return NextResponse.json({ code: error.engineCode, message: error.message }, { status: error.status, headers: NO_STORE });
      }
      return canonicalWaitingFailure(error, "تعذّر حجز الموعد. أعد المحاولة.");
    }
  }
  const session = await requireSession();
  if (!session) return denied();
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }

  const source = (body ?? {}) as Record<string, unknown>;
  const text = (key: string, max: number): string | null => {
    const value = source[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  };
  const integer = (key: string): number | null => {
    const value = Number(source[key]);
    return Number.isInteger(value) && value > 0 ? value : null;
  };

  try {
    const patientId = Number(source.patientId);
    if (Number.isInteger(patientId) && patientId > 0 && !await canAccessPatient(session, patientId)) {
      return NextResponse.json({ message: "غير مصرّح لك بحجز موعد لهذا المريض." }, { status: 403 });
    }
    /* التجاوز يُقرأ من المستخدم في القاعدة لا من الجلسة: الجلسة كوكي، والصلاحية
       قرارٌ يُغيَّر من شاشة المستخدمين فيسري فورًا لا بعد خروجٍ ودخول. */
    const actor = await findUserByUsername(session.username).catch(() => null);
    /* بابٌ واحد للحجز — هو نفسه الذي يمرّ منه الوكيل الذكي. */
    const result = await bookAppointment({
      patientId: Number(source.patientId),
      date: typeof source.date === "string" ? source.date : "",
      time: typeof source.time === "string" ? source.time : "",
      durationMinutes: source.durationMinutes == null ? null : Number(source.durationMinutes),
      serviceId: integer("serviceId"),
      appointmentType: text("appointmentType", 60),
      bookingIntent: source.bookingIntent === "ortho_follow_up" ? "ortho_follow_up" : undefined,
      note: text("note", 300),
      doctorId: integer("doctorId"),
      chairNo: source.chairNo == null || source.chairNo === "" ? null : Number(source.chairNo),
      overrideReason: text("overrideReason", 300),
      nearbyAppointmentConfirmation: text("nearbyAppointmentConfirmation", 4096),
      returnBookingSource: source.returnBookingSource as ReturnBookingSource | null | undefined,
      returnBookingOrigin: source.returnBookingOrigin as ReturnBookingSource | null | undefined,
      returnBookingFingerprint: text("returnBookingFingerprint", 128),
      isNewPatient: source.isNewPatient === true,
    }, {
      username: session.username, userId: session.userId,
      role: session.role,
      doctorPartyId: actor?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null),
      canOverrideCapacity: actor?.permissions?.canOverrideCapacity === true,
      channel: "ui",
    });

    if (!result.ok) {
      return result.status === 409
        ? NextResponse.json(result.conflict, { status: 409 })
        : NextResponse.json({ message: result.message, ...(result.code ? { code: result.code } : {}) }, { status: 400 });
    }
    /* تنبيهٌ لا خطأ: الموعد حُجز، والاستقبال تُخبَر لتتأكّد قبل أن تَعِد المريض. */
    return NextResponse.json(
      result.warning ? { ...result.appointment, warning: result.warning } : result.appointment,
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر حجز الموعد. أعد المحاولة." }, { status: 500 });
  }
}

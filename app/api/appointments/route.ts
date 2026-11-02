import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  CLINIC_TIME_ZONE, doctorOwnedPatientIds, findUserByUsername, labWorkForPatients, listAppointmentsByDate,
} from "@/lib/db";
import { labReadinessFor, type LabReadinessItem } from "@/lib/lab-readiness";
import { clinicDateString, type Appointment } from "@/lib/schedule";
import { bookAppointment } from "@/lib/book-appointment";
import { bookDirectPurposeAppointment } from "@/lib/book-direct-purpose";
import { requireSession } from "@/lib/session";
import { isAppointmentPurpose, planRequiredForPurpose } from "@/lib/appointment-purpose";
import type { DirectAppointmentIntent } from "@/lib/appointment-purpose-command";

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
  const session = await requireSession();
  if (!session) return denied();
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded; return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }

  const source = (body ?? {}) as Record<string, unknown>;
  const hasPurpose = Object.prototype.hasOwnProperty.call(source, "appointmentPurpose");
  if (!hasPurpose && Object.prototype.hasOwnProperty.call(source,'commandId'))
    return NextResponse.json({message:'معرّف الأمر يتطلب غرض موعد صريحًا.'},{status:400});
  if (hasPurpose && !isAppointmentPurpose(source.appointmentPurpose))
    return NextResponse.json({ message: "غرض الموعد غير صالح." }, { status: 400 });
  if (hasPurpose && planRequiredForPurpose(source.appointmentPurpose as import('@/lib/appointment-purpose').AppointmentPurpose))
    return NextResponse.json({ message: "هذا الغرض يتطلب حجز زيارة مخططة من خطة المريض؛ لا يُحجز مباشرةً." }, { status: 400 });
  // New classified writes reject noncanonical patient IDs; do not rewrite
  // legacy request parsing while unrelated AI/waiting-list callers rely on it.
  if (hasPurpose && !(typeof source.patientId === "number" && Number.isSafeInteger(source.patientId) && source.patientId > 0))
    return NextResponse.json({ message: "رقم المريض غير صالح." }, { status: 400 });
  const text = (key: string, max: number): string | null => {
    const value = source[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  };
  const integer = (key: string): number | null => {
    const value = Number(source[key]);
    return Number.isInteger(value) && value > 0 ? value : null;
  };

  // Classified direct bookings have a separate durable command boundary.
  // Pass raw fields to its strict normalizer; the legacy coercions below must
  // not collapse two distinct bodies into the same recovery receipt.
  if (hasPurpose) {
    if (!['admin','reception','doctor'].includes(session.role))
      return NextResponse.json({message:'غير مصرّح لك بتوثيق غرض موعد.'},{status:403});
    try {
      const result = await bookDirectPurposeAppointment({
        patientId: source.patientId, date: source.date, time: source.time,
        durationMinutes: source.durationMinutes, serviceId: source.serviceId,
        appointmentType: source.appointmentType, note: source.note,
        doctorId: source.doctorId, chairNo: source.chairNo,
        overrideReason: source.overrideReason, isNewPatient: source.isNewPatient,
        bookingIntent: source.bookingIntent, waitingListId: source.waitingListId,
        appointmentPurpose: source.appointmentPurpose, commandId: source.commandId,
      } as DirectAppointmentIntent & {commandId:string}, {
        username:session.username,role:session.role,channel:'ui',session,
      });
      if (!result.ok) return NextResponse.json(result.conflict??{message:result.message},{status:result.status});
      if (result.replayed) return NextResponse.json({id:result.appointmentId,status:result.status,replayed:true},{status:200});
      return NextResponse.json(result.warning ? {...result.appointment,warning:result.warning} : result.appointment,{status:201});
    } catch (error) {
      if ((error as Error).message==='APPOINTMENT_PURPOSE_SESSION_EXPIRED')
        return NextResponse.json({message:'انتهت الجلسة أثناء الحجز؛ لم يُحفظ موعد.'},{status:401});
      if ((error as {code?:string}).code==='55P03')
        return NextResponse.json({message:'يجري تحديث ارتباط المريض بخطته؛ حدّث الملف وأعد المحاولة.'},{status:409});
      return NextResponse.json({message:'تعذّر حجز الموعد. تحقّق من النتيجة باستخدام معرّف الأمر نفسه قبل إعادة المحاولة.'},{status:500});
    }
  }

  try {
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
      isNewPatient: source.isNewPatient === true,
    }, {
      username: session.username,
      role: session.role,
      doctorPartyId: actor?.partyId ?? (typeof session.partyId === "number" ? session.partyId : null),
      canOverrideCapacity: actor?.permissions?.canOverrideCapacity === true,
      channel: "ui",
    });

    if (!result.ok) {
      return result.status === 409
        ? NextResponse.json(result.conflict, { status: 409 })
        : NextResponse.json({ message: result.message }, { status: result.status });
    }
    /* تنبيهٌ لا خطأ: الموعد حُجز، والاستقبال تُخبَر لتتأكّد قبل أن تَعِد المريض. */
    return NextResponse.json(
      result.warning ? { ...result.appointment, warning: result.warning } : result.appointment,
      { status: 201 },
    );
  } catch (error) {
    if ((error as Error).message === "APPOINTMENT_PURPOSE_SESSION_EXPIRED")
      return NextResponse.json({message:"انتهت الجلسة أثناء الحجز؛ لم يُحفظ موعد."},{status:401});
    if ((error as {code?:string}).code === "55P03")
      return NextResponse.json({message:"يجري تحديث ارتباط المريض بخطته؛ حدّث الملف وأعد المحاولة."},{status:409});
    return NextResponse.json({ message: "تعذّر حجز الموعد. أعد المحاولة." }, { status: 500 });
  }
}

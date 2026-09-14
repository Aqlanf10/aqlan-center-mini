import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { doctorOwnedPatientIds, findUserByUsername, listAppointmentsByDate } from "@/lib/db";
import { bookAppointment } from "@/lib/book-appointment";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
          return NextResponse.json(
            list.filter((a) => !a.doctorId || a.doctorId === doctorPartyId || owned.has(a.patientId)),
          );
        }
        return NextResponse.json([]);
      }
    }
    return NextResponse.json(list);
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
  const text = (key: string, max: number): string | null => {
    const value = source[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  };
  const integer = (key: string): number | null => {
    const value = Number(source[key]);
    return Number.isInteger(value) && value > 0 ? value : null;
  };

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
        : NextResponse.json({ message: result.message }, { status: 400 });
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

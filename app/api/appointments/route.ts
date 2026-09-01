import { NextResponse } from "next/server";
import { chairCount } from "@/lib/settings";
import { doctorOwnedPatientIds, findUserByUsername, getSettings, insertAppointmentOnClient, listAppointmentsByDate, writeAppointmentInDay } from "@/lib/db";
import { checkSlot, nextFreeTime } from "@/lib/schedule";
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
  try { body = await request.json(); } catch { return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }

  const source = (body ?? {}) as Record<string, unknown>;
  const patientId = Number(source.patientId);
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  const durationMinutes = Number(source.durationMinutes ?? 30);
  const appointmentType = typeof source.appointmentType === "string" && source.appointmentType.trim()
    ? source.appointmentType.trim().slice(0, 60)
    : null;
  const note = typeof source.note === "string" ? source.note.trim() : "";

  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }

  try {
    const chairs = chairCount(await getSettings());
    // الحارس يُطبَّق على الخادم لا في الواجهة وحدها. والفحص والكتابة داخل قفل
    // اليوم الذرّي: جهازان يحجزان في اللحظة نفسها فيتنافسان على القفل نفسه،
    // فيرى الثاني مواعيد الأول ويُبعَد بدل أن يكتبا فوق كرسيٍّ واحد.
    const result = await writeAppointmentInDay({
      date,
      judge: (sameDay) => {
        const verdict = checkSlot(sameDay, date, time, durationMinutes, chairs);
        if (verdict.allowed) return { ok: true as const };
        const suggestion = nextFreeTime(sameDay, date, time, durationMinutes, chairs);
        return {
          ok: false as const,
          conflict: {
            message: verdict.reason,
            // بديل محدد بدل رفض مجرّد: الاستقبال تقول للمريض وقتًا، لا «جرّب غيره».
            suggestion,
            suggestionMessage: suggestion ? `أقرب وقت متاح: ${suggestion}` : "لا يوجد وقت متاح في هذا اليوم.",
          },
        };
      },
      commit: (client) =>
        insertAppointmentOnClient(client, {
          patientId,
          date,
          time,
          durationMinutes,
          appointmentType,
          note: note ? note.slice(0, 300) : null,
          /* الطبيب يحجز لنفسه فيُسجّل موعده على جهته فيراه في جدوله المحجوب. */
          doctorId: session.role === "doctor" && typeof session.partyId === "number" && session.partyId > 0
            ? session.partyId
            : (Number.isInteger(Number(source.doctorId)) && Number(source.doctorId) > 0
              ? Number(source.doctorId)
              : null),
        }),
    });

    if (!result.ok) {
      return NextResponse.json(result.conflict, { status: 409 });
    }
    return NextResponse.json(result.value, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حجز الموعد. أعد المحاولة." }, { status: 500 });
  }
}

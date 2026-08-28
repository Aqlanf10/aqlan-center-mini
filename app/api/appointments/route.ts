import { NextResponse } from "next/server";
import { chairCount } from "@/lib/settings";
import { createAppointment, getSettings, listAppointmentsByDate } from "@/lib/db";
import { checkSlot, nextFreeTime } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  if (!(await requireSession())) return denied();
  const date = new URL(request.url).searchParams.get("date") ?? "";
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }
  try {
    return NextResponse.json(await listAppointmentsByDate(date));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل مواعيد اليوم." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await requireSession())) return denied();
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }

  const source = (body ?? {}) as Record<string, unknown>;
  const patientId = Number(source.patientId);
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  const durationMinutes = Number(source.durationMinutes ?? 30);
  const note = typeof source.note === "string" ? source.note.trim() : "";

  if (!Number.isInteger(patientId) || patientId <= 0) {
    return NextResponse.json({ message: "اختر المريض أولًا." }, { status: 400 });
  }
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
  }

  try {
    const chairs = chairCount(await getSettings());
    // الحارس يُطبَّق على الخادم لا في الواجهة وحدها: جهازان يحجزان في اللحظة نفسها
    // لا يراهما بعضهما، والفحص هنا هو الوحيد الذي يراهما.
    const sameDay = await listAppointmentsByDate(date);
    const verdict = checkSlot(sameDay, date, time, durationMinutes, chairs);
    if (!verdict.allowed) {
      const suggestion = nextFreeTime(sameDay, date, time, durationMinutes, chairs);
      return NextResponse.json(
        {
          message: verdict.reason,
          // بديل محدد بدل رفض مجرّد: الاستقبال تقول للمريض وقتًا، لا «جرّب غيره».
          suggestion,
          suggestionMessage: suggestion ? `أقرب وقت متاح: ${suggestion}` : "لا يوجد وقت متاح في هذا اليوم.",
        },
        { status: 409 },
      );
    }

    const created = await createAppointment({
      patientId, date, time, durationMinutes, note: note ? note.slice(0, 300) : null,
    });
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حجز الموعد. أعد المحاولة." }, { status: 500 });
  }
}

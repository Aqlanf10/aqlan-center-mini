import { NextResponse } from "next/server";
import { chairCount } from "@/lib/settings";
import { getSettings, insertAppointmentOnClient, listAppointmentsByDate, writeAppointmentInDay } from "@/lib/db";
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
          patientId, date, time, durationMinutes, note: note ? note.slice(0, 300) : null,
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

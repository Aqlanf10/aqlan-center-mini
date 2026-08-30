import { NextResponse } from "next/server";
import { chairCount } from "@/lib/settings";
import { createNextSession, getSettings, writeAppointmentInDay } from "@/lib/db";
import { checkSlot, nextFreeTime } from "@/lib/schedule";
import { toWhatsAppNumber } from "@/lib/reminders";
import { requireSession } from "@/lib/session";

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
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const visitId = Number(rawId);
  if (!Number.isInteger(visitId) || visitId <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
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
    const chairs = chairCount(await getSettings());
    // نفس قفل اليوم الذرّي: الجلسة القادمة حجزٌ يُحسب في السعة، فلا يفلت
    // من الحارس لو قرأ يومًا قديمًا قبل كتابة حجزٍ متزامن.
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
            suggestion,
            suggestionMessage: suggestion ? `أقرب وقت متاح: ${suggestion}` : "لا يوجد وقت متاح في هذا اليوم.",
          },
        };
      },
      commit: (client) =>
        createNextSession({ visitId, date, time, durationMinutes, phone, note }, client),
    });
    if (!result.ok) {
      return NextResponse.json(result.conflict, { status: 409 });
    }
    const created = result.value;
    if (!created) {
      return NextResponse.json({ message: "الزيارة غير موجودة." }, { status: 404 });
    }
    return NextResponse.json(created, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حجز الجلسة. أعد المحاولة." }, { status: 500 });
  }
}

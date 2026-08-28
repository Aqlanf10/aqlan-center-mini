import { NextResponse } from "next/server";
import { chairCount } from "@/lib/settings";
import {
  confirmBookingRequest,
  getSettings,
  listAppointmentsByDate,
  rejectBookingRequest,
} from "@/lib/db";
import { checkSlot, nextFreeTime } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الطلب غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const action = typeof source.action === "string" ? source.action : "";

  try {
    if (action === "reject") {
      const rejected = await rejectBookingRequest(id);
      if (!rejected) {
        return NextResponse.json({ message: "الطلب عولج سلفًا." }, { status: 409 });
      }
      return NextResponse.json(rejected);
    }

    if (action === "confirm") {
      const date = typeof source.date === "string" ? source.date : "";
      const time = typeof source.time === "string" ? source.time : "";
      const durationMinutes = Number(source.durationMinutes ?? 30);
      if (!DATE_PATTERN.test(date)) {
        return NextResponse.json({ message: "تاريخ غير صالح." }, { status: 400 });
      }

      // نفس حارس السعة الذي يحمي الحجز اليدوي: تأكيد الطلب حجزٌ كامل، ولو تجاوز
      // الحارس لدخل من الباب الخلفي ما مُنع من الباب الأمامي.
      const chairs = chairCount(await getSettings());
      const sameDay = await listAppointmentsByDate(date);
      const verdict = checkSlot(sameDay, date, time, durationMinutes, chairs);
      if (!verdict.allowed) {
        const suggestion = nextFreeTime(sameDay, date, time, durationMinutes, chairs);
        return NextResponse.json({
          message: verdict.reason,
          suggestion,
          suggestionMessage: suggestion ? `أقرب وقت متاح: ${suggestion}` : "لا يوجد وقت متاح في هذا اليوم.",
        }, { status: 409 });
      }

      const confirmed = await confirmBookingRequest({ id, date, time, durationMinutes });
      if (!confirmed) {
        return NextResponse.json({ message: "الطلب عولج سلفًا." }, { status: 409 });
      }
      return NextResponse.json(confirmed, { status: 201 });
    }

    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

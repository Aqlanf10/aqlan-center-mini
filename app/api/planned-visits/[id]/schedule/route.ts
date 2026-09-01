import { NextResponse } from "next/server";
import { getSettings, schedulePlannedVisit } from "@/lib/db";
import { chairCount } from "@/lib/settings";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;

/**
 * تحويل الزيارة المخطَّطة موعدًا — بتاريخٍ ووقت فقط (المواصفة §١١).
 *
 * سبب الموعد والعلاج والمدة والطبيب كلها في الزيارة المخطَّطة أصلًا؛ إعادة إدخالها
 * موعدًا مستقلًّا هو ما يجعل الاتفاق يُكتب مرتين فيخالف إحداهما الأخرى يوم الخلاف.
 * والكتابة تمرّ من قفل اليوم الذرّي نفسه الذي يمرّ عليه كل حجز.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }

  const { id } = await context.params;
  const plannedVisitId = Number(id);
  if (!Number.isInteger(plannedVisitId) || plannedVisitId <= 0) {
    return NextResponse.json({ message: "رقم الزيارة المخطَّطة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const date = typeof source.date === "string" ? source.date : "";
  const time = typeof source.time === "string" ? source.time : "";
  if (!DATE_PATTERN.test(date)) {
    return NextResponse.json({ message: "التاريخ غير صالح." }, { status: 400 });
  }
  if (!TIME_PATTERN.test(time)) {
    return NextResponse.json({ message: "الوقت غير صالح." }, { status: 400 });
  }

  try {
    const chairs = chairCount(await getSettings());
    const result = await schedulePlannedVisit({ plannedVisitId, date, time, chairs });

    if (result.ok) {
      return NextResponse.json(
        { appointmentId: result.appointmentId, title: result.title }, { status: 201 },
      );
    }
    if (result.reason === "conflict") {
      return NextResponse.json(result.conflict, { status: 409 });
    }
    const messages: Record<string, string> = {
      not_found: "الزيارة المخطَّطة غير موجودة.",
      not_schedulable: "هذه الزيارة المخطَّطة منجَزة أو ملغاة.",
      already_scheduled: "الزيارة المخطَّطة محوَّلة موعدًا سلفًا.",
    };
    return NextResponse.json(
      { message: messages[result.reason] ?? "تعذّر جدولة الجلسة." },
      { status: 409 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر حجز الجلسة. أعد المحاولة." }, { status: 500 });
  }
}

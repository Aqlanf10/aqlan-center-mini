import { NextResponse } from "next/server";
import {
  listLapsedPatients,
  listMissedAppointments,
  markAppointmentFollowedUp,
  markPatientRecalled,
} from "@/lib/db";
import { LAPSE_OPTIONS } from "@/lib/recall";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  if (!(await requireSession())) return denied();
  const requested = Number(new URL(request.url).searchParams.get("weeks") ?? 6);
  // المدة من قائمة مغلقة لا من الطلب مباشرة: رقمٌ ضخم يجعل الاستعلام يمسح الجدول كله.
  const weeks = (LAPSE_OPTIONS as readonly number[]).includes(requested) ? requested : 6;

  try {
    const [missed, lapsed] = await Promise.all([
      listMissedAppointments(),
      listLapsedPatients(weeks),
    ]);
    return NextResponse.json({ missed, lapsed, weeks });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قائمة المتابعة." }, { status: 500 });
  }
}

/** يسجّل أن المتابعة تمّت — يُستدعى بعد فتح واتساب أو بعد المكالمة، لا قبلهما. */
export async function POST(request: Request) {
  if (!(await requireSession())) return denied();
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const kind = typeof source.kind === "string" ? source.kind : "";
  const id = Number(source.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم غير صالح." }, { status: 400 });
  }

  try {
    const done = kind === "missed"
      ? await markAppointmentFollowedUp(id)
      : kind === "lapsed"
        ? await markPatientRecalled(id)
        : null;
    if (done === null) return NextResponse.json({ message: "نوع غير معروف." }, { status: 400 });
    if (!done) return NextResponse.json({ message: "السجل غير موجود أو تغيّرت حالته." }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر تسجيل المتابعة. أعد المحاولة." }, { status: 500 });
  }
}

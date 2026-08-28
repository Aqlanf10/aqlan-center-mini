import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { addVisit, listTodayVisits } from "@/lib/db";

export const dynamic = "force-dynamic";

/** رسالة عربية لكل عطل — لا يظهر نص إنجليزي لموظفة الاستقبال أبدًا. */
function failed(message: string, status = 500) {
  return NextResponse.json({ message }, { status });
}

export async function GET() {
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  try {
    return NextResponse.json(await listTodayVisits());
  } catch {
    // تفاصيل الاستثناء لا تخرج في الاستجابة — قد تحمل رابط قاعدة البيانات.
    return failed("تعذّر تحميل قائمة اليوم. تحقق من الاتصال ثم أعد المحاولة.");
  }
}

export async function POST(request: Request) {
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failed("طلب غير صالح.", 400);
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const patientName = typeof source.patientName === "string" ? source.patientName.trim() : "";
  if (!patientName) return failed("اسم المريض مطلوب.", 400);
  if (patientName.length > 120) return failed("اسم المريض طويل أكثر من اللازم.", 400);

  const phoneRaw = typeof source.patientPhone === "string" ? source.patientPhone.trim() : "";
  const noteRaw = typeof source.note === "string" ? source.note.trim() : "";

  try {
    const visit = await addVisit({
      patientName,
      patientPhone: phoneRaw || null,
      note: noteRaw ? noteRaw.slice(0, 300) : null,
    });
    return NextResponse.json(visit, { status: 201 });
  } catch {
    return failed("تعذّر تسجيل المريض. أعد المحاولة.");
  }
}

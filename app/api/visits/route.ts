import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { addVisit, listTodayVisits, startVisitFromPlannedVisit } from "@/lib/db";

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
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failed("طلب غير صالح.", 400);
  }

  const source = (body ?? {}) as Record<string, unknown>;

  /*
   * بدء الزيارة من زيارةٍ مخطَّطة — الرحلة V2.
   *
   * الزيارة تُنشأ مربوطةً بمريضها وجلساتها من الزيارة المخطَّطة نفسها: يعرف الطبيب
   * «مخطَّط لليوم» قبل أن يفتح الفم، والاستقبال لا تعيد إدخال شيء. والمدخل الآخر
   * (اسمٌ حر) يبقى كما هو للمريض المشي.
   */
  const rawPlannedVisitId = Number(source.plannedVisitId);
  if (Number.isInteger(rawPlannedVisitId) && rawPlannedVisitId > 0) {
    try {
      const started = await startVisitFromPlannedVisit({
        plannedVisitId: rawPlannedVisitId,
        actor: session.username,
      });
      if (started && "alreadyActive" in started) {
        return NextResponse.json(
          { message: "لهذه الجلسة زيارة قائمة سلفًا.", visitId: started.visitId },
          { status: 409 },
        );
      }
      if (!started) {
        return failed("الزيارة المخطَّطة غير موجودة أو لا يمكن بدؤها.", 404);
      }
      return NextResponse.json(started, { status: 201 });
    } catch {
      return failed("تعذّر بدء الزيارة من الجلسة المخطَّطة. أعد المحاولة.");
    }
  }

  const patientName = typeof source.patientName === "string" ? source.patientName.trim() : "";
  if (!patientName) return failed("اسم المريض مطلوب.", 400);
  if (patientName.length > 120) return failed("اسم المريض طويل أكثر من اللازم.", 400);

  const phoneRaw = typeof source.patientPhone === "string" ? source.patientPhone.trim() : "";
  const noteRaw = typeof source.note === "string" ? source.note.trim() : "";

  // ملفُّ المريض إن اختارته الاستقبال من قائمة المطابقات — وهو ما يمنع الملف الثاني.
  const rawPatientId = Number(source.patientId);
  const patientId = Number.isInteger(rawPatientId) && rawPatientId > 0 ? rawPatientId : null;

  // الطبيب المعالج للزيارة إن تم تحديده
  const rawDoctorId = Number(source.doctorId);
  const doctorId = Number.isInteger(rawDoctorId) && rawDoctorId > 0
    ? rawDoctorId
    : (session.role === "doctor" && typeof session.partyId === "number" && session.partyId > 0
      ? session.partyId
      : null);

  try {
    const visit = await addVisit({
      patientName,
      patientPhone: phoneRaw || null,
      note: noteRaw ? noteRaw.slice(0, 300) : null,
      patientId,
      doctorId,
    });
    return NextResponse.json(visit, { status: 201 });
  } catch {
    return failed("تعذّر تسجيل المريض. أعد المحاولة.");
  }
}

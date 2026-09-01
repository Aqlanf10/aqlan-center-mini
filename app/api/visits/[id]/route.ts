import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { callVisit, callVisitAgain, finishVisit, linkVisitToPatient, returnVisitToWaiting, seatVisit } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الزيارة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const action = typeof source.action === "string" ? source.action : "";

  try {
    if (action === "call") {
      const chair = Number(source.chair);
      if (!Number.isInteger(chair) || chair <= 0) {
        return NextResponse.json({ message: "رقم الكرسي غير صالح." }, { status: 400 });
      }
      const called = await callVisit(id, chair);
      if (!called) {
        return NextResponse.json(
          { message: "الكرسي محجوز لمريض آخر أو تغيّرت حالة المريض. حدّثت اللوحة — راجعها." },
          { status: 409 },
        );
      }
      return NextResponse.json(called);
    }

    // إعادة النداء: المريض لم ينتبه للشاشة — يُحدَّث ختمة النداء فيصدر الوميض
    // والنغمة والنطق من جديد على التلفاز، والكرسي يبقى محجوزًا له.
    if (action === "call_again") {
      const again = await callVisitAgain(id);
      if (!again) {
        return NextResponse.json(
          { message: "لا يوجد نداء قائم لإعادته — ربما دخل المريض الكرسي أو عاد للانتظار." },
          { status: 409 },
        );
      }
      return NextResponse.json(again);
    }

    if (action === "seat") {
      const chair = Number(source.chair);
      if (!Number.isInteger(chair) || chair <= 0) {
        return NextResponse.json({ message: "رقم الكرسي غير صالح." }, { status: 400 });
      }
      const seated = await seatVisit(id, chair);
      // فشل الإجلاس يعني أن جهازًا آخر سبقنا إلى الكرسي، أو أن المريض لم يعد منتظرًا.
      // الرسالة تقول ذلك بدل «حدث خطأ»، لأن الإجراء الصحيح مختلف تمامًا: انظر اللوحة.
      if (!seated) {
        return NextResponse.json(
          { message: "الكرسي شُغل للتو أو تغيّرت حالة المريض. حدّثت اللوحة — راجعها." },
          { status: 409 },
        );
      }
      return NextResponse.json(seated);
    }

    if (action === "return") {
      const returned = await returnVisitToWaiting(id);
      if (!returned) {
        return NextResponse.json({ message: "المريض لم يعد في حالة نداء." }, { status: 409 });
      }
      return NextResponse.json(returned);
    }

    if (action === "finish") {
      const finished = await finishVisit(id);
      if (!finished) {
        return NextResponse.json({ message: "الزيارة منتهية بالفعل." }, { status: 409 });
      }
      return NextResponse.json(finished);
    }

    // ربط الزيارة بملفٍّ قائم — قرارٌ بشري لا مطابقةٌ صامتة بالاسم.
    if (action === "link") {
      const patientId = Number(source.patientId);
      if (!Number.isInteger(patientId) || patientId <= 0) {
        return NextResponse.json({ message: "رقم الملف غير صالح." }, { status: 400 });
      }
      const linked = await linkVisitToPatient(id, patientId);
      if (!linked.ok) return NextResponse.json({ message: linked.message }, { status: 409 });
      return NextResponse.json({ ok: true, patientName: linked.patientName });
    }

    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

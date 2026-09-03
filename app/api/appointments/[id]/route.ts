import { NextResponse } from "next/server";
import { arriveAppointment, deleteAppointment, markReminderSent, setAppointmentStatus } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الموعد غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 }); }
  const action = typeof (body as Record<string, unknown>)?.action === "string"
    ? String((body as Record<string, unknown>).action) : "";

  try {
    if (action === "arrive") {
      // الوصول يفتح صفًّا في اللوحة — هذا ما يجعل الحجز والانتظار نظامًا واحدًا.
      const ok = await arriveAppointment(id);
      if (!ok) {
        return NextResponse.json(
          { message: "سُجّل وصوله بالفعل أو تغيّرت حالة الموعد." },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true });
    }
    if (action === "reminded") {
      // يُستدعى بعد فتح واتساب لا قبله: التسجيل قبل الفتح يزعم إرسالًا لم يحدث.
      const ok = await markReminderSent(id);
      if (!ok) return NextResponse.json({ message: "الموعد غير موجود." }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    if (action === "cancel" || action === "no_show") {
      const updated = await setAppointmentStatus(id, action === "cancel" ? "cancelled" : "no_show");
      if (!updated) return NextResponse.json({ message: "الموعد غير موجود." }, { status: 404 });
      return NextResponse.json(updated);
    }
    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

/* حذف موعد نهائيًا — المدير وحده، وللموعد الذي لم يتحول زيارةً بعد. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "حذف المواعيد للمدير وحده." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الموعد غير صالح." }, { status: 400 });
  }

  let reason: string | null = null;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body?.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 300);
    }
  } catch { /* لا سبب — ليس شرطًا */ }

  try {
    const result = await deleteAppointment(id, { actor: session.username, actorRole: session.role, reason });
    if (!result.ok) {
      if (result.reason === "arrived") {
        return NextResponse.json(
          { message: "صاحب الموعد وصل وتحوّل زيارةً — لا يُحذف، أُنهِ الزيارة أو ألغِ الموعد." },
          { status: 409 },
        );
      }
      return NextResponse.json({ message: "الموعد غير موجود." }, { status: 404 });
    }
    return NextResponse.json({ message: "حُذف الموعد وسُجِّل في التدقيق." });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف الموعد. أعد المحاولة." }, { status: 500 });
  }
}

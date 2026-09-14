import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { markWaitingOffered, resolveWaitingEntry } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * تحديث انتظار — نداءٌ أو إغلاق.
 *
 * ولا حذف: من انتظر ثم اعتذر يبقى في السجلّ بسببه. وقائمةٌ تُحذف منها الأسماء
 * لا تُجيب «كم مريضًا ردَدْنا هذا الشهر؟» — وهو الرقم الذي يقول للمالك إن كان
 * يحتاج كرسيًّا ثالثًا.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الانتظار غير صالح." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";
  const actor = { actor: session.username, actorRole: session.role };

  try {
    if (action === "offer") {
      const result = await markWaitingOffered(id, actor);
      if (result.ok) return NextResponse.json({ ok: true });
      return NextResponse.json(
        {
          message: result.reason === "not_open"
            ? "هذا الانتظار نودي أو أُغلق سلفًا." : "الانتظار غير موجود.",
        },
        { status: result.reason === "not_open" ? 409 : 404 },
      );
    }

    if (action === "booked" || action === "cancelled" || action === "expired") {
      /* الإلغاء يلزمه سبب: «لماذا خرج من القائمة؟» سؤالٌ يُسأل حين يتّصل المريض
         بعد شهرٍ يسأل عن دوره. */
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (action === "cancelled" && !reason) {
        return NextResponse.json({ message: "اكتب سبب الإلغاء." }, { status: 400 });
      }
      const appointmentId = Number(body.appointmentId);
      const result = await resolveWaitingEntry(id, {
        status: action,
        reason: reason || null,
        appointmentId: Number.isInteger(appointmentId) && appointmentId > 0 ? appointmentId : null,
      }, actor);
      if (result.ok) return NextResponse.json({ ok: true });
      return NextResponse.json(
        {
          message: result.reason === "already_resolved"
            ? "هذا الانتظار مُغلقٌ سلفًا." : "الانتظار غير موجود.",
        },
        { status: result.reason === "already_resolved" ? 409 : 404 },
      );
    }

    return NextResponse.json({ message: "إجراء غير معروف." }, { status: 400 });
  } catch {
    return NextResponse.json({ message: "تعذّر تنفيذ الإجراء. أعد المحاولة." }, { status: 500 });
  }
}

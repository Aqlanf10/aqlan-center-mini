import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { canUseTasks, mutateTaskChecklist, type ChecklistOperation } from "@/lib/hr";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** قائمة التحقق: إضافة بند أو تحويله أو إزالته — العملية تُقرأ من جسم الطلب. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canUseTasks(session.role)) {
    return NextResponse.json({ message: "المهام خارج صلاحيات دورك." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم المهمة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  let operation: ChecklistOperation;
  // مفتاح معاملة العميل: فقدان الرد ثم إعادة الإرسال يعيد البند الأصلي لا نسخة.
  const clientRequestId = typeof source.clientRequestId === "string" && source.clientRequestId.trim().length >= 8
    ? source.clientRequestId.trim().slice(0, 100)
    : null;
  if (source.op === "add") {
    const label = typeof source.label === "string" ? source.label.trim() : "";
    if (!label || label.length > 300) {
      return NextResponse.json({ message: "بند التحقق نصٌّ من 1 إلى 300 حرف." }, { status: 400 });
    }
    operation = { op: "add", label, clientRequestId };
  } else if (source.op === "toggle") {
    const itemId = Number(source.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return NextResponse.json({ message: "بند التحقق غير صالح." }, { status: 400 });
    }
    operation = { op: "toggle", itemId, done: source.done === true };
  } else if (source.op === "remove") {
    const itemId = Number(source.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return NextResponse.json({ message: "بند التحقق غير صالح." }, { status: 400 });
    }
    operation = { op: "remove", itemId };
  } else {
    return NextResponse.json({ message: "عملية قائمة التحقق: إضافة أو تحويل أو إزالة." }, { status: 400 });
  }

  try {
    const result = await mutateTaskChecklist(id, operation, session);
    if (!result.ok) return NextResponse.json({ message: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر تحديث قائمة التحقق." }, { status: 500 });
  }
}

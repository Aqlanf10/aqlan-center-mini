import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { addTaskComment, canUseTasks } from "@/lib/hr";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** تعليق على مهمة — يُنسب لصاحب الجلسة فعلًا ولو نُفّذ نيابةً عن موظفٍ بلا حساب. */
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
  const commentBody = typeof source.body === "string" ? source.body.trim() : "";
  if (!commentBody || commentBody.length > 2000) {
    return NextResponse.json({ message: "اكتب التعليق (من 1 إلى 2000 حرف)." }, { status: 400 });
  }

  try {
    const result = await addTaskComment(id, commentBody, session);
    if (!result.ok) return NextResponse.json({ message: result.error }, { status: result.status });
    return NextResponse.json(result.value, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إضافة التعليق." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { cancelProviderBlock } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** إلغاء الحجب — طيٌّ بختمٍ ومن طواه، لا محوٌ من السجلّ. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إلغاء الحجب للمدير وحده." }, { status: 403 });
  }
  const { id } = await context.params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ message: "رقم الحجب غير صالح." }, { status: 400 });
  }
  try {
    const result = await cancelProviderBlock(id, {
      actor: session.username, actorRole: session.role,
    });
    if (result.ok) return NextResponse.json({ ok: true });
    return NextResponse.json(
      {
        message: result.reason === "already_cancelled"
          ? "هذا الحجب مُلغى سلفًا." : "الحجب غير موجود.",
      },
      { status: result.reason === "already_cancelled" ? 409 : 404 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر إلغاء الحجب. أعد المحاولة." }, { status: 500 });
  }
}

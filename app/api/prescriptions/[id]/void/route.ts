import { NextResponse } from "next/server";
import { voidPrescription } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { checkVoidReason } from "@/lib/prescription";

export const dynamic = "force-dynamic";

/**
 * إبطال وصفة — بسببٍ مكتوب لا حذف.
 *
 * المريض خرج بنسخته فتعديل المحفوظ يجعل نسختين يقولان شيئين؛ والصحيح إبطالٌ
 * موثَّق بالسبب واسم من أبطل، ثم وصفةٌ جديدة تصدر مكانها.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role) && session.role !== "doctor") {
    return NextResponse.json({ message: "إبطال الوصفات للطبيب والمدير." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم وصفة غير صالح." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const check = checkVoidReason(body.reason);
  if (!check.ok) {
    return NextResponse.json({ message: check.reason }, { status: 400 });
  }

  try {
    const result = await voidPrescription({ id, reason: check.reason, actor: session.username });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر إبطال الوصفة." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { reorderAiProviders } from "@/lib/ai-providers/registry";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إعادة ترتيب الأولويات للمدير وحده." }, { status: 403 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const { orderedIds } = (body ?? {}) as { orderedIds?: string[] };
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return NextResponse.json({ message: "قائمة المعرفات مطلوبة." }, { status: 400 });
  }

  try {
    await reorderAiProviders(orderedIds, session.username);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { message: `تعذّر حفظ الترتيب: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

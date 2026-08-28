import { NextResponse } from "next/server";
import { auditActors, listAudit } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * قراءة سجل التدقيق — **للمدير وحده، وقراءةً فقط**.
 *
 * لا `POST` ولا `PATCH` ولا `DELETE` في هذا الملف، وهذا ليس نقصًا يُكمَّل لاحقًا: هو
 * التنفيذ نفسه. السجل يُكتب من داخل العمليات عبر `recordAudit` ولا يُلمس من الخارج
 * أبدًا — والحماية في **غياب المسار** لا في صلاحية تُمنح وتُمنع.
 *
 * وقصره على المدير مقصود: السجل يقول من فعل ماذا ومتى، وهو سجل رقابة على الطاقم لا
 * أداة عمل له.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "سجل التدقيق للمدير وحده." }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const date = (key: string) => {
    const value = params.get(key);
    return value && DATE_PATTERN.test(value) ? value : null;
  };

  try {
    const [entries, actors] = await Promise.all([
      listAudit({
        from: date("from"),
        to: date("to"),
        action: params.get("action") || null,
        actor: params.get("actor") || null,
        entity: params.get("entity") || null,
        entityId: params.get("entityId") || null,
        limit: Number(params.get("limit")) || 200,
      }),
      auditActors(),
    ]);
    return NextResponse.json({ entries, actors });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل سجل التدقيق." }, { status: 500 });
  }
}

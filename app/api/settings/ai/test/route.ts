import { NextResponse } from "next/server";
import { testAiConnection } from "@/lib/ai";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * اختبار اتصال حقيقي بمزوّد الذكاء الاصطناعي.
 *
 * يقبل مفتاحًا جديدًا لم يُحفظ بعد — لكي يجرب المالك المفتاح **قبل** حفظه،
 * فلا يُخزَّن مفتاح خاطئ ليكتشف أنه خاطئ في يوم تشغيل لاحق. النتيجة تُثبَّت
 * في الإعدادات وتُسجَّل في التدقيق بلا أي قيمة حسّاسة.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "اختبار الاتصال للمدير وحده." }, { status: 403 });
  }

  let body: unknown = null;
  try { body = await request.json(); } catch {
    body = {}; // بلا جسم = اختبار بالمفتاح المحفوظ — مسار مشروع تمامًا.
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const apiKey = typeof source.apiKey === "string" ? source.apiKey : undefined;

  try {
    const outcome = await testAiConnection({ apiKey }, session.username, session.role);
    return NextResponse.json(outcome);
  } catch {
    return NextResponse.json(
      { ok: false, message: "تعذّر تنفيذ الاختبار — تحقق من الإعدادات والاتصال." },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { listCephReferenceSets } from "@/lib/db";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * المجموعات المرجعية المفعلة بقيمها.
 *
 * القياسات لا تحمل حكمًا داخلها: متوسط كل تحليل وانحرافه يأتي من مجموعة
 * مرجعية معلومة المصدر والإصدار — والأدمن يضيف مجموعات محلية لاحقًا دون
 * تغيير كود. القراءة لأي من يدخل البرنامج: المرجع لا سرٌّ فيه.
 */
export async function GET() {
  if (!(await requireSession())) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  try {
    const sets = await listCephReferenceSets();
    return NextResponse.json({ sets });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المجموعات المرجعية." }, { status: 500 });
  }
}

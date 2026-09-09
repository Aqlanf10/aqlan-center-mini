import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettings, listMaterialRates, setMaterialRate } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { parseRateBp } from "@/lib/materialRate";

export const dynamic = "force-dynamic";

/**
 * نسب إهلاك المواد لكل تخصص — قراءة للجميع، كتابةٌ للمدير وحده.
 * (من مستودع الوكيل الآخر.)
 *
 * والقراءة عامة للجلسات لأن النسبة يقرؤها الطبيب في تقرير عمولته — فلا تُدار
 * شاشة العمولات من مديرٍ وحده. أمّا الكتابة فهي قرارُ مالٍ يخصم من عمولات
 * الأطباء، فلا تُكتب إلا بيد المالك.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  try {
    const settings = await getSettings();
    return NextResponse.json({
      rates: await listMaterialRates(),
      applied: settings["finance.commission_material_rate"] === "on",
    });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل النسب." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "نسب إهلاك المواد للمدير وحده." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = (await readJsonBody<Record<string, unknown>>(request, SETTINGS_BODY_LIMIT_BYTES)); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const category = typeof body.category === "string" ? body.category : "";
  /* rateBp: رقم النقاط مباشرةً، أو `null` للمحو. والنصوص بالنسبة المئوية
     (كما تكتبها الشاشة) تُمرَّر في `rate` وتُحلّ بالنقاط هنا. */
  const rawRate = body.rateBp === null ? null : (body.rateBp ?? body.rate);
  const rateBp = rawRate === null ? null : parseRateBp(rawRate);
  if (rateBp === null && rawRate !== null) {
    return NextResponse.json({
      message: "نسبة غير صالحة — اكتبها بالمئة (7.5 مثلًا) وبين صفر ومئة.",
    }, { status: 400 });
  }

  try {
    const result = await setMaterialRate({ category, rateBp, actor: session.username });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ النسبة." }, { status: 500 });
  }
}

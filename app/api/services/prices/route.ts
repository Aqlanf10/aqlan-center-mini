import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getSettingsSafe, listServices, priceServiceBatch } from "@/lib/db";
import { parseAmount, type Currency, isCurrency } from "@/lib/money";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { readPriceBatch } from "@/lib/servicePricing";

export const dynamic = "force-dynamic";

/**
 * تسعير الأعمال دفعةً واحدة — **الخطوة التي تفصل المركز عن بدء التشغيل**.
 * (من مستودع الوكيل الآخر.)
 *
 * تسعيرُها واحدةً واحدةً حفظٌ وذهابٌ وإياب، ومن يبدأ ذلك يقف في المنتصف فيبقى
 * نصف الدليل مسعّرًا ونصفه لا — وهي أسوأ حالٍ من الاثنتين. فالدفعة كلُّها أو
 * لا شيء منها: رقمٌ خاطئ في سطرٍ واحد يردّها كلَّها باسم صاحبه.
 */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تسعير الدليل للمدير وحده." }, { status: 403 });
  }
  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const entries = (body as Record<string, unknown>)?.entries;
  if (!Array.isArray(entries)) {
    return NextResponse.json({ message: "لا أسعار في الطلب." }, { status: 400 });
  }

  // العملة الأساسية تحكم تحويل المبلغ إلى الوحدة الصغرى — من الإعدادات لا من الطلب.
  const settings = await getSettingsSafe();
  const base: Currency = isCurrency(settings["finance.base_currency"])
    ? settings["finance.base_currency"] : "YER";
  const services = await listServices(true);
  const nameOf = (id: number) => services.find((service) => service.id === id)?.name ?? null;

  const batch = readPriceBatch(
    entries,
    (input) => parseAmount(input, base),
    nameOf,
  );
  if (!batch.ok) {
    return NextResponse.json({ message: batch.message }, { status: 400 });
  }
  try {
    const result = await priceServiceBatch(batch.prices, session.username);
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 400 });
    return NextResponse.json({ updated: result.updated });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الدفعة." }, { status: 500 });
  }
}

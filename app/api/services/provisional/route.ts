import { NextResponse } from "next/server";
import { fillProvisionalServicePrices, listServices } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { provisionalFills } from "@/lib/provisionalPrices";

export const dynamic = "force-dynamic";

/**
 * ملء الأسعار التخمينية — **للتجربة وحدها، وتُوسَم بذلك في كل موضع تُرى فيه**.
 * (من مستودع الوكيل الآخر، مفهرسة بفئة الخدمة لدليلنا.)
 *
 * **وما سُعّر لا يُمسّ**: من سعّر خدمةً بيده قرّر، وكتابةُ تخمينٍ فوقه تمحو
 * قراره. وتعديلُ السعر بيد المالك لاحقًا يمسح الوسم — لأنّه حينها قرارُه.
 */
export async function POST() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "التسعير التخميني للمدير وحده." }, { status: 403 });
  }
  try {
    const services = await listServices(true);
    const fills = provisionalFills(services.map((service) => ({
      id: service.id,
      category: service.category,
      priceConfigured: service.priceConfigured,
      isActive: service.isActive,
    })));
    if (fills.length === 0) {
      return NextResponse.json({
        message: "لا خدمات نشطة بلا سعر تناسب التخميني — كل النشط مسعّر أصلًا.",
      }, { status: 400 });
    }
    const result = await fillProvisionalServicePrices(fills, session.username);
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 400 });
    return NextResponse.json({ filled: result.filled });
  } catch {
    return NextResponse.json({ message: "تعذّر ملء الأسعار التخمينية." }, { status: 500 });
  }
}

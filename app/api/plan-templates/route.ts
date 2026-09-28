import { NextResponse } from "next/server";
import { findUserByUsername, listServices } from "@/lib/db";
import { canViewMoney } from "@/lib/roles";
import { DEFAULT_SPECIALTY_TEMPLATES } from "@/lib/specialty-templates";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (SPEC-T1) قوالب الخطط حسب التخصص — لشاشة «خطة من قالب». خطواتٌ وفئات خدماتٍ وجلسات،
 * والأسعار تُحسب من الدليل عند الإنشاء على الخادم.
 *
 * ومعها **خدمات الدليل الفعّالة للاختيار**: الطبيب الذي لا يرى لائحة الأسعار (canViewServicePrices)
 * يأخذ الأسماء والفئات بلا أسعار — كان يُمنع من /api/services فتبقى القائمة فارغة، ويسقط الخادم
 * صامتًا إلى أول خدمةٍ في الفئة (عصب سنٍّ أمامي لطاحونة). الآن يختار الخدمة الصحيحة دائمًا.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  try {
    let showPrices = canViewMoney(session.role);
    if (session.role === "doctor") {
      const user = await findUserByUsername(session.username).catch(() => null);
      showPrices = Boolean(user?.permissions?.canViewServicePrices);
    }
    const services = (await listServices()).map((service) => ({
      id: service.id, name: service.name, category: service.category,
      sortOrder: service.sortOrder, isActive: service.isActive,
      priceMinor: showPrices ? service.priceMinor : null,
    }));
    return NextResponse.json({ templates: DEFAULT_SPECIALTY_TEMPLATES, services, showPrices });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قوالب الخطط." }, { status: 500 });
  }
}

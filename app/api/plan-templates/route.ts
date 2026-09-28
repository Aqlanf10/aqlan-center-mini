import { NextResponse } from "next/server";
import { findUserByUsername, getSettings, listServices } from "@/lib/db";
import { canViewMoney, isAdmin } from "@/lib/roles";
import { effectiveTemplates } from "@/lib/specialty-templates";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * (SPEC-T1/T2) قوالب الخطط حسب التخصص — المحفوظة في الإعدادات إن عدّلها المالك، وإلا الجاهزة.
 * خطواتٌ وفئات خدماتٍ وجلسات، والأسعار تُحسب من الدليل عند الإنشاء على الخادم. والتعديل عبر
 * مسار الإعدادات المدقَّق نفسه (plans.specialty_templates).
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
    const [settings, catalog] = await Promise.all([getSettings(), listServices()]);
    const { templates, customized } = effectiveTemplates(settings["plans.specialty_templates"]);
    const services = catalog.map((service) => ({
      id: service.id, name: service.name, category: service.category,
      sortOrder: service.sortOrder, isActive: service.isActive,
      priceMinor: showPrices ? service.priceMinor : null,
    }));
    return NextResponse.json({ templates, customized, canEdit: isAdmin(session.role), services, showPrices });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قوالب الخطط." }, { status: 500 });
  }
}

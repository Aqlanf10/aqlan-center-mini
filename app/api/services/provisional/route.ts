import { NextResponse } from "next/server";
import { fillProvisionalServicePrices, listServices, recordAudit } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { provisionalFills } from "@/lib/provisionalPrices";
import { canonicalServicesRoute } from "@/lib/canonical-services-http";
import { commandCanonicalServiceProvisional } from "@/lib/canonical-services";

export const dynamic = "force-dynamic";

/**
 * ملء الأسعار التخمينية — **للتجربة وحدها، وتُوسَم بذلك في كل موضع تُرى فيه**.
 * (من مستودع الوكيل الآخر، مفهرسة بفئة الخدمة لدليلنا.)
 *
 * **وما سُعّر لا يُمسّ**: من سعّر خدمةً بيده قرّر، وكتابةُ تخمينٍ فوقه تمحو
 * قراره. وتعديلُ السعر بيد المالك لاحقًا يمسح الوسم — لأنّه حينها قرارُه.
 */
export async function POST() {
  // M2 slice 96: finance.service-prices.edit; fills computed from the locked catalogue.
  const canonical = await canonicalServicesRoute(null, handle => commandCanonicalServiceProvisional(handle), "تعذّر ملء الأسعار التخمينية.");
  if (canonical) return canonical;
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
    // (P1-4) الأسعار التقديرية تدخل الفواتير — فمن ملأها ومتى وبأي قيمة يُدقَّق.
    // (M2 slice 96 fix) Only the rows actually written: a service priced by hand after the
    // list above is skipped by the writer's guard and must not be audited as filled.
    const nameOf = new Map(services.map((service) => [service.id, service.name]));
    await recordAudit({
      action: "service.prices.provisional",
      entity: "service", entityLabel: `${result.applied.length} خدمة`,
      details: { الأسعار: result.applied.map((fill) => ({ الخدمة: nameOf.get(fill.id) ?? null, رقم: fill.id, السعر: fill.priceMinor })) },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json({ filled: result.filled });
  } catch {
    return NextResponse.json({ message: "تعذّر ملء الأسعار التخمينية." }, { status: 500 });
  }
}

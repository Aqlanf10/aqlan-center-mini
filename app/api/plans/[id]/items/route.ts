import { NextResponse } from "next/server";
import { addPlanItem, getService, removePlanItem } from "@/lib/db";
import { canHandleMoney } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * بنود خطة العلاج.
 *
 * السعر يُقرأ من **دليل الخدمات** لا من الطلب: سعرٌ يأتي من المتصفّح سعرٌ يمكن
 * تغييره في المتصفّح. والدليل هو مصدر الحقيقة الوحيد للأسعار في البرنامج كلّه —
 * وهو ما يجعل تعديل السعر مرةً واحدةً في مكانٍ واحد يسري على كل ما بعده.
 */

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const forbidden = () =>
  NextResponse.json({ message: "خطط العلاج للإدارة والاستقبال." }, { status: 403 });

const planIdFrom = async (context: { params: Promise<{ id: string }> }) => {
  const { id } = await context.params;
  const value = Number(id);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) return forbidden();

  const planId = await planIdFrom(context);
  if (!planId) return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const serviceId = Number(source.serviceId);
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return NextResponse.json({ message: "اختر الخدمة من الدليل." }, { status: 400 });
  }

  const quantity = Math.round(Number(source.quantity ?? 1));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) {
    return NextResponse.json({ message: "العدد بين 1 و99." }, { status: 400 });
  }

  const toothCode = source.toothCode === null || source.toothCode === undefined || source.toothCode === ""
    ? null : Number(source.toothCode);
  if (toothCode !== null && !Number.isInteger(toothCode)) {
    return NextResponse.json({ message: "رقم السن غير صالح." }, { status: 400 });
  }

  try {
    const service = await getService(serviceId);
    if (!service) return NextResponse.json({ message: "الخدمة غير موجودة في الدليل." }, { status: 404 });

    const result = await addPlanItem({
      planId,
      serviceId: service.id,
      serviceName: service.name,
      category: service.category,
      toothCode,
      surfaces: typeof source.surfaces === "string" ? source.surfaces : null,
      quantity,
      unitPriceMinor: service.priceMinor,
      note: typeof source.note === "string" ? source.note.slice(0, 300) : null,
    });
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    return NextResponse.json({ totalMinor: result.totalMinor }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إضافة البند." }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) return forbidden();

  const planId = await planIdFrom(context);
  if (!planId) return NextResponse.json({ message: "رقم الخطة غير صالح." }, { status: 400 });

  const itemId = Number(new URL(request.url).searchParams.get("itemId"));
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });
  }

  try {
    const result = await removePlanItem(planId, itemId);
    if (!result.ok) return NextResponse.json({ message: result.message }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف البند." }, { status: 500 });
  }
}

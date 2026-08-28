import { NextResponse } from "next/server";
import { getSettings, updateService } from "@/lib/db";
import { isCurrency, parseAmount } from "@/lib/money";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تعديل الأسعار للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الخدمة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patch: { name?: string; category?: string | null; priceMinor?: number; isActive?: boolean } = {};

  if (typeof source.name === "string") {
    const name = source.name.trim();
    if (!name || name.length > 120) {
      return NextResponse.json({ message: "اكتب اسم الخدمة." }, { status: 400 });
    }
    patch.name = name;
  }
  if (typeof source.category === "string") {
    patch.category = source.category.trim().slice(0, 60) || null;
  }
  if (source.price !== undefined) {
    const settings = await getSettings();
    const base = settings["finance.base_currency"];
    if (!isCurrency(base)) {
      return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
    }
    const priceMinor = parseAmount(String(source.price), base);
    if (priceMinor === null) {
      return NextResponse.json({ message: "اكتب سعرًا صحيحًا." }, { status: 400 });
    }
    patch.priceMinor = priceMinor;
  }
  if (typeof source.isActive === "boolean") patch.isActive = source.isActive;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ message: "لا يوجد ما يُحدَّث." }, { status: 400 });
  }

  try {
    const updated = await updateService(id, patch);
    if (!updated) return NextResponse.json({ message: "الخدمة غير موجودة." }, { status: 404 });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التعديل." }, { status: 500 });
  }
}

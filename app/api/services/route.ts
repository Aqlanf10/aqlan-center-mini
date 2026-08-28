import { NextResponse } from "next/server";
import { createService, listServices } from "@/lib/db";
import { isCurrency, parseAmount } from "@/lib/money";
import { getSettings } from "@/lib/db";
import { canHandleMoney, isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  const includeInactive = new URL(request.url).searchParams.get("all") === "1";
  try {
    return NextResponse.json(await listServices(includeInactive));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل قائمة الأسعار." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canHandleMoney(session.role)) {
    return NextResponse.json({ message: "الصندوق والفواتير للإدارة والاستقبال." }, { status: 403 });
  }
  // قائمة الأسعار تحكم كل فاتورة بعدها، فتحريرها للمدير وحده.
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "تعديل الأسعار للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json({ message: "اكتب اسم الخدمة." }, { status: 400 });
  }
  const settings = await getSettings();
  const base = settings["finance.base_currency"];
  if (!isCurrency(base)) {
    return NextResponse.json({ message: "العملة الأساسية في الإعدادات غير صالحة." }, { status: 500 });
  }
  const priceMinor = parseAmount(String(source.price ?? ""), base);
  if (priceMinor === null) {
    return NextResponse.json({ message: "اكتب سعرًا صحيحًا." }, { status: 400 });
  }
  const category = typeof source.category === "string" && source.category.trim()
    ? source.category.trim().slice(0, 60) : null;

  try {
    return NextResponse.json(await createService({ name, category, priceMinor }), { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ الخدمة." }, { status: 500 });
  }
}

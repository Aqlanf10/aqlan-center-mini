import { NextResponse } from "next/server";
import {
  createInventoryItem, inventoryAlerts, listInventoryItems,
} from "@/lib/db";
import { itemCategoryLabel } from "@/lib/inventory";
import { clinicDateString } from "@/lib/schedule";
import { canManageInventory } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** قائمة المخزون مع التنبيهات — القراءة لكل من دخول البرنامج: المخزون ليس سرًّا. */
export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  try {
    const [items, alerts] = await Promise.all([
      listInventoryItems(),
      inventoryAlerts(clinicDateString(new Date(), "Asia/Aden")),
    ]);
    return NextResponse.json({ items, alerts });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المخزون." }, { status: 500 });
  }
}

/** بند جديد — للمدير والاستقبال. البداية بلا رصيد: أول حركة إدخال موثَّق. */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageInventory(session.role)) {
    return NextResponse.json(
      { message: "بنود المخزون للمدير والاستقبال — الطبيب يسجّل الاستهلاك على البنود القائمة." },
      { status: 403 },
    );
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const name = typeof source.name === "string" ? source.name.trim().slice(0, 120) : "";
  if (!name) {
    return NextResponse.json({ message: "اكتب اسم البند." }, { status: 400 });
  }
  const category = typeof source.category === "string" && source.category.trim()
    ? source.category.trim().slice(0, 40) : "other";
  const unit = typeof source.unit === "string" && source.unit.trim()
    ? source.unit.trim().slice(0, 20) : "وحدة";
  const minLevel = Number(source.minLevel);
  const note = typeof source.note === "string" && source.note.trim()
    ? source.note.trim().slice(0, 300) : null;
  if (!Number.isFinite(minLevel) || minLevel < 0) {
    return NextResponse.json({ message: "حد الطلب رقمٌ لا يقل عن صفر." }, { status: 400 });
  }

  try {
    const item = await createInventoryItem({
      name, category, unit, minLevel, note, createdBy: session.username,
    });
    return NextResponse.json(
      { ...item, categoryLabel: itemCategoryLabel(item.category) },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء البند. أعد المحاولة." }, { status: 500 });
  }
}

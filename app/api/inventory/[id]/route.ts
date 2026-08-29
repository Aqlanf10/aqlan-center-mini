import { NextResponse } from "next/server";
import { getInventoryItemDetail, updateInventoryItem } from "@/lib/db";
import { canManageInventory } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const readId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/** تفصيل بند: الرصيد المشتق، وسجل الحركات، ودفعات الصلاحية بما بقي فيها. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  const { id: rawId } = await context.params;
  const id = readId(rawId);
  if (!id) return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });
  try {
    const detail = await getInventoryItemDetail(id);
    if (!detail) return NextResponse.json({ message: "البند غير موجود." }, { status: 404 });
    return NextResponse.json(detail);
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل تفاصيل البند." }, { status: 500 });
  }
}

/**
 * تعديل بيانات البند — بياناتُ وصفٍ فقط: الاسم والوحدة والحدّ والتفعيل.
 * لا رصيدًا هنا ولا في أي مسار: الرصيد حصيلةُ حركاتٍ أو مرفوض الدستور (ZONE_D).
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canManageInventory(session.role)) {
    return NextResponse.json({ message: "تعديل البنود للمدير والاستقبال." }, { status: 403 });
  }
  const { id: rawId } = await context.params;
  const id = readId(rawId);
  if (!id) return NextResponse.json({ message: "رقم البند غير صالح." }, { status: 400 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patch: Parameters<typeof updateInventoryItem>[1] = {};
  if (typeof source.name === "string" && source.name.trim()) patch.name = source.name.trim().slice(0, 120);
  if (typeof source.category === "string" && source.category.trim()) patch.category = source.category.trim().slice(0, 40);
  if (typeof source.unit === "string" && source.unit.trim()) patch.unit = source.unit.trim().slice(0, 20);
  if (source.minLevel !== undefined) {
    const minLevel = Number(source.minLevel);
    if (!Number.isFinite(minLevel) || minLevel < 0) {
      return NextResponse.json({ message: "حد الطلب رقمٌ لا يقل عن صفر." }, { status: 400 });
    }
    patch.minLevel = minLevel;
  }
  if (source.note !== undefined) {
    patch.note = typeof source.note === "string" && source.note.trim()
      ? source.note.trim().slice(0, 300) : null;
  }
  if (source.isActive !== undefined) patch.isActive = Boolean(source.isActive);

  try {
    const item = await updateInventoryItem(id, patch, session.username);
    if (!item) return NextResponse.json({ message: "البند غير موجود." }, { status: 404 });
    return NextResponse.json(item);
  } catch {
    return NextResponse.json({ message: "تعذّر تعديل البند. أعد المحاولة." }, { status: 500 });
  }
}

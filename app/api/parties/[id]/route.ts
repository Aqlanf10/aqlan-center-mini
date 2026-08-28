import { NextResponse } from "next/server";
import { updateParty } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة الجهات للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم الجهة غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patch: {
    name?: string; phone?: string | null; commissionPercent?: number;
    note?: string | null; isActive?: boolean;
  } = {};

  if (typeof source.name === "string") {
    const name = source.name.trim();
    if (!name || name.length > 120) {
      return NextResponse.json({ message: "اكتب اسم الجهة." }, { status: 400 });
    }
    patch.name = name;
  }
  if (typeof source.phone === "string") patch.phone = source.phone.trim().slice(0, 40) || null;
  if (typeof source.note === "string") patch.note = source.note.trim().slice(0, 300) || null;
  if (typeof source.isActive === "boolean") patch.isActive = source.isActive;
  if (source.commissionPercent !== undefined) {
    const percent = Number(String(source.commissionPercent).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return NextResponse.json({ message: "النسبة بين 0 و100." }, { status: 400 });
    }
    patch.commissionPercent = percent;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ message: "لا يوجد ما يُحدَّث." }, { status: 400 });
  }

  try {
    const updated = await updateParty(id, patch);
    if (!updated) return NextResponse.json({ message: "الجهة غير موجودة." }, { status: 404 });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التعديل." }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { countActiveAdmins, listUsers, updateUser } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { isAdmin, isRole } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
  }
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة المستخدمين للمدير وحده." }, { status: 403 });
  }

  const { id: rawId } = await context.params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ message: "رقم المستخدم غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const patch: { displayName?: string; role?: string; isActive?: boolean; passwordHash?: string } = {};

  if (typeof source.displayName === "string") {
    const displayName = source.displayName.trim();
    if (!displayName || displayName.length > 80) {
      return NextResponse.json({ message: "اكتب الاسم الظاهر." }, { status: 400 });
    }
    patch.displayName = displayName;
  }
  if (source.role !== undefined) {
    if (!isRole(source.role)) return NextResponse.json({ message: "دور غير معروف." }, { status: 400 });
    patch.role = source.role;
  }
  if (typeof source.isActive === "boolean") patch.isActive = source.isActive;
  if (typeof source.password === "string" && source.password) {
    if (source.password.length < 8) {
      return NextResponse.json({ message: "كلمة المرور يجب ألا تقل عن 8 أحرف." }, { status: 400 });
    }
    patch.passwordHash = await hashPassword(source.password);
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ message: "لا يوجد ما يُحدَّث." }, { status: 400 });
  }

  try {
    // آخر مدير فاعل لا يُوقَف ولا يُنزَّل دوره: عيادة بلا مدير لا يستطيع أحد فيها
    // فتح الإعدادات ولا إعادة تعيين مدير — لأن ذلك نفسه يحتاج مديرًا.
    const droppingAdmin = patch.isActive === false || (patch.role !== undefined && patch.role !== "admin");
    if (droppingAdmin) {
      const users = await listUsers();
      const target = users.find((user) => user.id === id);
      if (target?.role === "admin" && target.isActive && (await countActiveAdmins()) <= 1) {
        return NextResponse.json(
          { message: "لا يمكن إيقاف آخر مدير أو تغيير دوره. عيّن مديرًا آخر أولًا." },
          { status: 409 },
        );
      }
    }

    const updated = await updateUser(id, patch);
    if (!updated) return NextResponse.json({ message: "المستخدم غير موجود." }, { status: 404 });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التعديل." }, { status: 500 });
  }
}

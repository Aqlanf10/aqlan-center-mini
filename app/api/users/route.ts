import { NextResponse } from "next/server";
import { createStaffUser, findUserByUsername, listUsers, recordAudit } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { isAdmin, isRole } from "@/lib/roles";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });
const forbidden = () =>
  NextResponse.json({ message: "إدارة المستخدمين للمدير وحده." }, { status: 403 });

export async function GET() {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();
  try {
    return NextResponse.json(await listUsers());
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المستخدمين." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return forbidden();

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;

  const username = typeof source.username === "string" ? source.username.trim() : "";
  // اسم الدخول بلا مسافات ولا حروف عربية: يُكتب على لوحة مفاتيح قد تكون بالإنجليزية،
  // ومسافةٌ في آخره خطأٌ لا يراه أحد ويمنع الدخول إلى الأبد.
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    return NextResponse.json(
      { message: "اسم الدخول بالإنجليزية والأرقام فقط، من 3 إلى 32 حرفًا." },
      { status: 400 },
    );
  }
  const displayName = typeof source.displayName === "string" ? source.displayName.trim() : "";
  if (!displayName || displayName.length > 80) {
    return NextResponse.json({ message: "اكتب الاسم الظاهر." }, { status: 400 });
  }
  const password = typeof source.password === "string" ? source.password : "";
  if (password.length < 8) {
    return NextResponse.json({ message: "كلمة المرور يجب ألا تقل عن 8 أحرف." }, { status: 400 });
  }
  if (!isRole(source.role)) {
    return NextResponse.json({ message: "اختر الدور." }, { status: 400 });
  }

  try {
    if (await findUserByUsername(username)) {
      return NextResponse.json({ message: "اسم الدخول مستخدم بالفعل." }, { status: 409 });
    }
    const created = await createStaffUser({
      username, displayName, role: source.role,
      passwordHash: await hashPassword(password),
    });
    await recordAudit({
      action: "user.create", entity: "user", entityId: created.id,
      entityLabel: created.username,
      details: { الدور: created.role, الاسم: created.displayName },
      actor: session.username, actorRole: session.role,
    });
    return NextResponse.json({
      id: created.id, username: created.username,
      displayName: created.displayName, role: created.role, isActive: created.isActive,
    }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء المستخدم." }, { status: 500 });
  }
}

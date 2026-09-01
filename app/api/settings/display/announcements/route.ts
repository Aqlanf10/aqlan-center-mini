import { NextResponse } from "next/server";
import {
  createDisplayAnnouncement,
  ensureDisplayAnnouncementsMigrated,
  listDisplayAnnouncements,
  recordAudit,
} from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { validateAnnouncementInput } from "@/lib/waiting-room";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * إعلانات شاشة الصالة — القائمة والإضافة.
 *
 * القراءة لكل من يملك جلسة (الشاشة تحرّكها الإدارة والاستقبال معًا في عيادةٍ
 * صغيرة)، والكتابة للمدير وحده: الإعلان كلمةٌ تُقال لكل من في الصالة، وليس
 * لكل من يعرف كلمة السر أن يقولها. نفس حدود إعدادات النظام كلها.
 */
export async function GET() {
  const session = await requireSession();
  if (!session) return denied();

  try {
    // أول فتحٍ للإعدادات بعد النشر يُرحِّل الخانة القديمة إن بقيت — والقارئ
    // هنا مديرٌ معروف فيُسجَّل الترحيل في سجل التدقيق باسمه.
    if (isAdmin(session.role)) {
      await ensureDisplayAnnouncementsMigrated({ username: session.username, role: session.role });
    }
    return NextResponse.json({ announcements: await listDisplayAnnouncements() });
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل الإعلانات." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) {
    return NextResponse.json({ message: "إدارة إعلانات الشاشة للمدير وحده." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as { title?: unknown; body?: unknown; isActive?: unknown };

  const verdict = validateAnnouncementInput(source);
  if (!verdict.ok) {
    return NextResponse.json({ message: verdict.message }, { status: 400 });
  }
  const isActive = source.isActive === undefined ? true : source.isActive === true;

  try {
    const announcement = await createDisplayAnnouncement({
      title: verdict.value.title,
      body: verdict.value.body,
      isActive,
      actor: session.username,
    });
    await recordAudit({
      action: "display.announcement.create",
      entity: "display_announcement",
      entityId: announcement.id,
      entityLabel: announcement.title,
      details: { العنوان: announcement.title },
      actor: session.username,
      actorRole: session.role,
    });
    return NextResponse.json({ announcement }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "ANNOUNCEMENTS_LIMIT") {
      return NextResponse.json(
        { message: "بلغت السقف الوقائي للإعلانات — راجع القائمة وحذف ما لا يُعرض." },
        { status: 400 },
      );
    }
    return NextResponse.json({ message: "تعذّر إضافة الإعلان. أعد المحاولة." }, { status: 500 });
  }
}

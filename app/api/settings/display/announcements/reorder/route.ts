import { NextResponse } from "next/server";
import { listDisplayAnnouncements, recordAudit, reorderDisplayAnnouncements } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { parseAnnouncementReorder } from "@/lib/waiting-room";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/**
 * إعادة ترتيب الإعلانات — القائمة كاملة بترتيبها الجديد.
 *
 * السحب والإفلات في الواجهة يبني القائمة كلها بالترتيب الجديد ويرسلها
 * دفعةً واحدة: أرقام الترتيب تُعاد كتابتها متتالية فلا تتشابك أبدًا. والقائمة
 * الناقصة عن الجدول (أضاف زميلٌ إعلانًا في نافذة أخرى) تُرفض فتُعاد الواجهة
 * إلى الحقيقة — لا يُدفن إعلانٌ جديدٌ في ترتيبٍ لم يُسأل عنه.
 */
export async function PATCH(request: Request) {
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
  const source = (body ?? {}) as { ids?: unknown };
  const ids = parseAnnouncementReorder(source.ids);
  if (ids === null) {
    return NextResponse.json(
      { message: "قائمة الترتيب غير صالحة — أرقام الإعلانات كاملةً بلا تكرار." },
      { status: 400 },
    );
  }

  try {
    await reorderDisplayAnnouncements(ids);
    const announcements = await listDisplayAnnouncements();
    await recordAudit({
      action: "display.announcement.reorder",
      entity: "display_announcement",
      details: { العدد: ids.length },
      actor: session.username,
      actorRole: session.role,
    });
    return NextResponse.json({ announcements });
  } catch (error) {
    if (error instanceof Error && error.message === "ANNOUNCEMENTS_REORDER_INCOMPLETE") {
      return NextResponse.json(
        { message: "قائمة الترتيب لم تعد مطابقة — أعد تحميل الصفحة وأعد المحاولة." },
        { status: 409 },
      );
    }
    return NextResponse.json({ message: "تعذّر حفظ الترتيب. أعد المحاولة." }, { status: 500 });
  }
}

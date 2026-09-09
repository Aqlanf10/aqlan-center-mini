import { NextResponse } from "next/server";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { deleteDisplayAnnouncement, recordAudit, updateDisplayAnnouncement } from "@/lib/db";
import { isAdmin } from "@/lib/roles";
import { requireSession } from "@/lib/session";
import { parseAnnouncementId, validateAnnouncementPatch } from "@/lib/waiting-room";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

const adminOnly = () =>
  NextResponse.json({ message: "إدارة إعلانات الشاشة للمدير وحده." }, { status: 403 });

/**
 * إعلان واحد — تعديلٌ جزئي أو حذف.
 *
 * التعديل بالحقل المُرسَل وحده: تعطيل إعلانٍ (isActive) لا يمرّ فوق نصّه،
 * وتصحيح حرفٍ في النص لا يلمس تفعيله. والحذف نهائي — الإعلان يُستبدل لا
 * يُحاسَب، ومَن حذفه يُسأل عنه في سجل التدقيق باسمه.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return adminOnly();

  const { id } = await params;
  const announcementId = parseAnnouncementId(id);
  if (announcementId === null) {
    return NextResponse.json({ message: "إعلان غير صالح." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as { title?: unknown; body?: unknown; isActive?: unknown };

  const verdict = validateAnnouncementPatch(source);
  if (!verdict.ok) {
    return NextResponse.json({ message: verdict.message }, { status: 400 });
  }

  try {
    const announcement = await updateDisplayAnnouncement(
      announcementId,
      verdict.value,
      session.username,
    );
    if (!announcement) {
      return NextResponse.json({ message: "الإعلان غير موجود — ربما حُذف من نافذة أخرى." }, { status: 404 });
    }
    await recordAudit({
      action: "display.announcement.update",
      entity: "display_announcement",
      entityId: announcement.id,
      entityLabel: announcement.title,
      details: { الحقول: Object.keys(verdict.value) },
      actor: session.username,
      actorRole: session.role,
    });
    return NextResponse.json({ announcement });
  } catch {
    return NextResponse.json({ message: "تعذّر حفظ التعديل. أعد المحاولة." }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (!session) return denied();
  if (!isAdmin(session.role)) return adminOnly();

  const { id } = await params;
  const announcementId = parseAnnouncementId(id);
  if (announcementId === null) {
    return NextResponse.json({ message: "إعلان غير صالح." }, { status: 400 });
  }

  try {
    const removed = await deleteDisplayAnnouncement(announcementId);
    if (!removed) {
      return NextResponse.json({ message: "الإعلان غير موجود — ربما حُذف من نافذة أخرى." }, { status: 404 });
    }
    await recordAudit({
      action: "display.announcement.delete",
      entity: "display_announcement",
      entityId: announcementId,
      actor: session.username,
      actorRole: session.role,
    });
    return NextResponse.json({ removed: true });
  } catch {
    return NextResponse.json({ message: "تعذّر حذف الإعلان. أعد المحاولة." }, { status: 500 });
  }
}

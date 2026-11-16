import { NextResponse } from "next/server";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { getPortalStaffAccess } from "@/lib/portal-security";
import {
  createPortalAnnouncement,
  deletePortalAnnouncement,
  listPortalAnnouncementsForAdmin,
  reorderPortalAnnouncements,
  updatePortalAnnouncement,
} from "@/lib/portal-settings";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { requireSessionStrict } from "@/lib/session";

export const dynamic = "force-dynamic";

async function resolveAnnouncementStaff() {
  const session = await requireSessionStrict();
  if (!session) {
    return { ok: false as const, status: 401, message: "انتهت الجلسة." };
  }
  if (session.role !== "admin" && session.role !== "reception") {
    return {
      ok: false as const,
      status: 403,
      message: "إدارة إعلانات بوابة المريض مخصّصة للإدارة والاستقبال المخوّل فقط.",
    };
  }
  const access = await getPortalStaffAccess(session.userId);
  if (!access || !access.isActive) {
    return { ok: false as const, status: 401, message: "انتهت الجلسة." };
  }
  return { ok: true as const, access };
}

export async function GET() {
  const auth = await resolveAnnouncementStaff();
  if (!auth.ok) {
    return NextResponse.json({ message: auth.message }, { status: auth.status });
  }
  const { access } = auth;
  if (
    access.role !== "admin" &&
    !access.isOwner &&
    !access.canManagePortalAnnouncements
  ) {
    return NextResponse.json(
      { message: "غير مصرّح لك بعرض أو إدارة إعلانات بوابة المريض." },
      { status: 403 },
    );
  }

  try {
    const announcements = await listPortalAnnouncementsForAdmin();
    return NextResponse.json({
      announcements,
      canEdit: Boolean(access.isOwner || access.canManagePortalAnnouncements),
    });
  } catch {
    return NextResponse.json(
      { message: "تعذّر تحميل قائمة إعلانات البوابة." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const auth = await resolveAnnouncementStaff();
  if (!auth.ok) {
    return NextResponse.json({ message: auth.message }, { status: auth.status });
  }
  const { access } = auth;
  if (!access.isOwner && !access.canManagePortalAnnouncements) {
    return NextResponse.json(
      { message: "غير مصرّح لك بإدارة إعلانات وأخبار بوابة المريض." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  try {
    if (payload.action === "reorder") {
      const reordered = await reorderPortalAnnouncements(access, payload.orderedIds);
      if (!reordered.ok) {
        return NextResponse.json({ message: reordered.message }, { status: reordered.status });
      }
      return NextResponse.json({ ok: true, announcements: reordered.items });
    }

    const created = await createPortalAnnouncement(access, payload);
    if (!created.ok) {
      return NextResponse.json({ message: created.message }, { status: created.status });
    }
    const announcements = await listPortalAnnouncementsForAdmin();
    return NextResponse.json({ ok: true, item: created.item, announcements }, { status: 201 });
  } catch {
    return NextResponse.json(
      { message: "تعذّر حفظ إعلان البوابة." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  const auth = await resolveAnnouncementStaff();
  if (!auth.ok) {
    return NextResponse.json({ message: auth.message }, { status: auth.status });
  }
  const { access } = auth;
  if (!access.isOwner && !access.canManagePortalAnnouncements) {
    return NextResponse.json(
      { message: "غير مصرّح لك بتعديل إعلانات بوابة المريض." },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }

  const payload = (body ?? {}) as Record<string, unknown>;
  const id = Number(payload.id);
  try {
    const updated = await updatePortalAnnouncement(access, id, payload);
    if (!updated.ok) {
      return NextResponse.json({ message: updated.message }, { status: updated.status });
    }
    const announcements = await listPortalAnnouncementsForAdmin();
    return NextResponse.json({ ok: true, item: updated.item, announcements });
  } catch {
    return NextResponse.json(
      { message: "تعذّر تحديث إعلان البوابة." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const auth = await resolveAnnouncementStaff();
  if (!auth.ok) {
    return NextResponse.json({ message: auth.message }, { status: auth.status });
  }
  const { access } = auth;
  if (!access.isOwner && !access.canManagePortalAnnouncements) {
    return NextResponse.json(
      { message: "غير مصرّح لك بحذف إعلانات بوابة المريض." },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  let id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    try {
      const body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
      id = Number(body?.id);
    } catch (error) {
      const bounded = bodyErrorResponse(error);
      if (bounded) return bounded;
      id = 0;
    }
  }

  try {
    const deleted = await deletePortalAnnouncement(access, id);
    if (!deleted.ok) {
      return NextResponse.json({ message: deleted.message }, { status: deleted.status });
    }
    const announcements = await listPortalAnnouncementsForAdmin();
    return NextResponse.json({ ok: true, announcements });
  } catch {
    return NextResponse.json(
      { message: "تعذّر حذف إعلان البوابة." },
      { status: 500 },
    );
  }
}

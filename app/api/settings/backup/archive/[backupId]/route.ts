import path from "node:path";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { deleteVerifiedBackupArchive } from "@/lib/backupAdmin";
import { requireBackupAdminReadOnly } from "@/lib/backupReadOnly";
import { isValidBackupArchiveId, resolveBackupDirectory } from "@/lib/backupVolume";
import { isAdmin } from "@/lib/roles";

export const dynamic = "force-dynamic";

const noStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function DELETE(
  request: Request,
  context: { params: Promise<{ backupId: string }> },
) {
  const auth = await requireBackupAdminReadOnly();
  if (!auth.ok) {
    return noStore(
      { message: auth.reason === "users-unreadable" ? "المصادقة غير متاحة الآن." : "سجّل الدخول من جديد." },
      auth.reason === "users-unreadable" ? 503 : 401,
    );
  }
  if (!isAdmin(auth.session.role)) {
    return noStore({ message: "حذف النسخ الاحتياطية للمدير وحده." }, 403);
  }

  const { backupId } = await context.params;
  if (!isValidBackupArchiveId(backupId)) {
    return noStore({ message: "معرّف النسخة غير صالح." }, 400);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return noStore({ message: "طلب غير صالح." }, 400);
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const reason = typeof source.reason === "string" ? source.reason.trim() : "";
  const confirmation = typeof source.confirmation === "string" ? source.confirmation : "";
  if (reason.length < 5) {
    return noStore({ message: "اكتب سببًا واضحًا للحذف (5 أحرف على الأقل)." }, 400);
  }
  if (confirmation !== backupId) {
    return noStore({ message: "تأكيد الحذف لا يطابق النسخة المختارة." }, 409);
  }

  const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";
  if (!volumeRoot || !path.isAbsolute(volumeRoot)) {
    return noStore({ message: "القرص الدائم للنسخ غير مهيأ." }, 503);
  }

  let backupDir: string;
  try {
    backupDir = resolveBackupDirectory(volumeRoot);
  } catch {
    return noStore({ message: "وجهة النسخ غير مضبوطة." }, 503);
  }

  const result = await deleteVerifiedBackupArchive({
    backupDir,
    backupId,
    actor: auth.session.username,
    reason,
  });

  if (result.ok) {
    return noStore({
      ok: true,
      backupId: result.backupId,
      freedBytes: result.freedBytes,
      deletedAt: result.deletedAt,
    }, 200);
  }

  const messages: Record<string, string> = {
    "not-found": "النسخة غير موجودة أو لم تعد متاحة.",
    "only-verified": "هذه هي النسخة المتحققة الوحيدة؛ لا يمكن حذفها.",
    "latest-verified": "أحدث نسخة Verified محمية ولا يمكن حذفها.",
    "external-anchor": "هذه آخر نسخة ناجحة لوجهة خارجية ومحمية من الحذف.",
    "archive-missing": "السجل موجود لكن ملف الأرشيف مفقود؛ أوقف الحذف وراجع التخزين.",
    "delete-failed": "تعذّر حذف ملف النسخة من القرص الدائم.",
  };
  const status = result.reason === "not-found" ? 404
    : result.reason === "archive-missing" || result.reason === "delete-failed" ? 500
      : 409;
  return noStore({ ok: false, reason: result.reason, message: messages[result.reason] }, status);
}

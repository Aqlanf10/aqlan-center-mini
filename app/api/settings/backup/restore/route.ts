import path from "node:path";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import { requireBackupAdminReadOnly } from "@/lib/backupReadOnly";
import { isValidBackupArchiveId, resolveBackupDirectory } from "@/lib/backupVolume";
import { runAdminRestoreDrill } from "@/lib/restore/admin";
import { isAdmin } from "@/lib/roles";

export const dynamic = "force-dynamic";

const noStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const auth = await requireBackupAdminReadOnly();
  if (!auth.ok) {
    return noStore(
      { message: auth.reason === "users-unreadable" ? "المصادقة غير متاحة الآن." : "سجّل الدخول من جديد." },
      auth.reason === "users-unreadable" ? 503 : 401,
    );
  }
  if (!isAdmin(auth.session.role)) {
    return noStore({ message: "استعادة النسخ الاحتياطية للمدير وحده." }, 403);
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
  const backupId = typeof source.backupId === "string" ? source.backupId : "";
  const confirmation = typeof source.confirmation === "string" ? source.confirmation : "";
  if (!isValidBackupArchiveId(backupId)) {
    return noStore({ message: "معرّف النسخة غير صالح." }, 400);
  }
  if (confirmation !== backupId) {
    return noStore({ message: "تأكيد الاستعادة لا يطابق النسخة المختارة." }, 409);
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

  const result = await runAdminRestoreDrill({
    backupDir,
    backupId,
    actor: auth.session.username,
  });

  if (result.ok) {
    return noStore({
      ok: true,
      readyForCutover: true,
      backupId: result.backupId,
      archiveSha256: result.archiveSha256,
      documentsVerified: result.documentsVerified,
      tablesCount: result.tablesCount,
      durationMs: result.durationMs,
      targetEnvironment: result.targetEnvironment,
    }, 200);
  }

  const messages: Record<string, string> = {
    "missing-target": "هدف الاستعادة المعزول غير مهيأ بعد.",
    "missing-classification": "هدف الاستعادة موجود لكن تصنيفه staging/test غير مضبوط.",
    "unsafe-classification": "هدف الاستعادة غير آمن؛ يجب أن يكون staging أو test.",
    "target-not-dedicated": "هدف الاستعادة غير معلن كقاعدة مخصصة قابلة للمسح.",
    "production-collision": "هدف الاستعادة يطابق قاعدة الإنتاج؛ تم الرفض بنيويًا.",
    "backup-not-found": "النسخة غير موجودة أو لم تعد Verified ومتاحة.",
    "archive-integrity-mismatch": "فشل تحقق سلامة الأرشيف؛ لم تُلمس قاعدة الاستعادة.",
    "restore-failed": "فشل Restore Drill على الهدف المعزول. لم تُستعد بيانات فوق Production.",
  };
  const unavailable = [
    "missing-target",
    "missing-classification",
    "unsafe-classification",
    "target-not-dedicated",
    "production-collision",
  ].includes(result.reason);
  const status = result.reason === "backup-not-found" ? 404 : unavailable ? 503 : 500;
  return noStore({ ok: false, reason: result.reason, message: messages[result.reason] }, status);
}

export async function GET() {
  return noStore({ message: "تشغيل Restore Drill أمر POST حصرًا." }, 405);
}

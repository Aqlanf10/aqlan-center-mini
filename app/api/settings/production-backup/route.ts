import { NextResponse } from "next/server";
import path from "node:path";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { isAdmin } from "@/lib/roles";
import { requireBackupAdminReadOnly } from "@/lib/backupReadOnly";
import { storageStatus } from "@/lib/files";
import { assertDocumentsDirInsideVolume } from "@/lib/backupVolume";
import {
  PRODUCTION_BACKUP_TOKEN_ENV,
  productionRuntimeActivated,
  runProductionBackupOnce,
} from "@/lib/productionBackup";

export const dynamic = "force-dynamic";

/**
 * تفعيل النسخة الإنتاجية الكاملة — لمرة واحدة، للمدير وحده، بلا أي كتابة في
 * قاعدة الإنتاج.
 *
 * الجسم: { "token": "…" } فقط — الرمز لا يمر من query ولا من GET، ولا يظهر
 * في أي سجل. الحارس الزمني صارم: DATABASE_ENVIRONMENT=production **و** إشارة
 * Railway معًا — NODE_ENV وحده لا يفتح شيئًا. وكل فشل تكوينٍ في الإنتاج فشلٌ
 * مغلق (503) برسالة عامة: التكوين الناقص لا يفسَّر للعميل ولا يُخمَّن.
 *
 * الاستجابة الناجحة هي إثبات النسخة فقط: اسم الملف النسبي داخل مجلد backups
 * وحجمه وبصمته وبصمة SQL وعدد المستندات — لا مسارات مطلقة ولا أسرار.
 */

const noStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

const failClosed = () =>
  noStore({ message: "بوابة النسخة الإنتاجية غير مفعَّلة في هذه البيئة." }, 503);

export async function POST(request: Request) {
  // المصادقة قراءة حصرًا: توقيع HMAC ثم SELECT مباشر لصف المستخدم — بلا
  // ensureSchema. جدول users غائب أو غير مقروء ⇒ فشل مغلق لا إصلاح ضمني.
  const auth = await requireBackupAdminReadOnly();
  if (!auth.ok) {
    // الجلسة الغائبة أو الحساب المُبدَّل رفضٌ مصادقة عادي (401 كما كان) —
    // أما جدول users غير المقروء ففشلٌ مغلق (503): لا جلسة ولا إصلاح ضمني.
    return noStore(
      { message: auth.reason === "users-unreadable" ? "المصادقة غير متاحة الآن — يلزم تدخّل يدوي." : "سجّل الدخول من جديد." },
      auth.reason === "users-unreadable" ? 503 : 401,
    );
  }
  if (!isAdmin(auth.session.role)) {
    return noStore({ message: "تفعيل النسخة الإنتاجية للمدير وحده." }, 403);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, SETTINGS_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) {
      return noStore(
        { message: bounded.status === 413 ? "حجم الطلب يتجاوز الحد المسموح." : "طلب غير صالح." },
        bounded.status,
      );
    }
    return noStore({ message: "طلب غير صالح." }, 400);
  }

  const token = (body as Record<string, unknown> | null)?.token;
  if (typeof token !== "string" || token.length === 0 || token.length > 512) {
    return noStore({ message: "رمز التفعيل مطلوب." }, 400);
  }

  // الحارس الزمني: الإنتاج الحقيقي فقط — وإلا فشلٌ مغلق قبل فحص أي رمز.
  if (!productionRuntimeActivated()) return failClosed();

  const expectedToken = process.env[PRODUCTION_BACKUP_TOKEN_ENV]?.trim() ?? "";
  if (!expectedToken) return failClosed();

  const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";
  if (!volumeRoot || !path.isAbsolute(volumeRoot)) return failClosed();

  const documents = await storageStatus();
  if (!documents.ready || !documents.directory) return failClosed();
  try {
    assertDocumentsDirInsideVolume(documents.directory, volumeRoot);
  } catch {
    return failClosed();
  }

  const outcome = await runProductionBackupOnce({
    providedToken: token,
    expectedToken,
    volumeRoot,
    documentsDir: documents.directory,
    appCommitSha: process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ?? null,
    log: (message) => console.warn(message),
  });

  switch (outcome.kind) {
    case "completed":
      return noStore(outcome.proof, 200);
    case "replayed":
      return noStore({ ...outcome.proof, replay: true }, 200);
    case "misconfigured":
      return failClosed();
    case "denied":
      return noStore({ message: outcome.message }, 403);
    case "conflict":
      return noStore({ message: outcome.message }, 409);
    case "failed":
      return noStore({ message: outcome.message }, 500);
  }
}

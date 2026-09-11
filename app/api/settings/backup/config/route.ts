import { NextResponse } from "next/server";
import path from "node:path";
import { isAdmin } from "@/lib/roles";
import { requireBackupAdminReadOnly } from "@/lib/backupReadOnly";
import { getBackupSettingsReadOnly } from "@/lib/backupReadOnly";
import { storageStatus } from "@/lib/files";
import {
  assertDocumentsDirInsideVolume,
  resolveBackupDirectory,
} from "@/lib/backupVolume";
import {
  mergeBackupRunConfig,
  parseVolumeBackupConfigPatch,
  resolveBackupRunConfig,
} from "@/lib/backupConfig";
import { readVolumeBackupConfig, writeVolumeBackupConfig } from "@/lib/backupRuntimeConfig";
import { readJsonBody, bodyErrorResponse } from "@/lib/http-body";
import { SETTINGS_BODY_LIMIT_BYTES } from "@/lib/security-limits";

export const dynamic = "force-dynamic";

/**
 * تجاوز تكوين النسخ الدائم — مسار التفعيل **صفر-الكتابة** قبل بوابة الهجرة.
 *
 * ### لماذا هذه النقطة أصلًا
 *
 * النسخ التلقائي شرطٌ قبل تفعيل الهجرة — وتفعيله من شاشة الإعدادات العادية
 * كان سيتطلب INSERT/UPDATE في جدول الإعدادات، وهذا ينتهك بوابة صفر-الكتابة
 * قبل اعتماد الهجرة. الحل هنا: التجاوز يسكن **ملفًّا على القرص الدائم**
 * (`<volume>/backups/.backup-state/backup-config.json`) — الكتابة للقرص
 * الدائم حصرًا، وصفر كتابة في قاعدة الإنتاج من الباب إلى الختام.
 *
 * ### الأمان والصرامة
 *
 * * للمدير وحده عبر requireBackupAdminReadOnly — توقيع HMAC ثم SELECT
 *   مباشر، بلا ensureSchema.
 * * الجسم يُدقَّق بقائمة بيضاء صارمة (parseVolumeBackupConfigPatch): لا
 *   مفاتيح مجهولة، لا أنواع ملتبسة، لا حدود مكسورة — أي خرق ⇒ 400.
 * * القيم تُدمج فوق التجاوز القائم ثم تُكتب ذرّيًّا (مؤقّت فريد + fsync +
 *   rename) — وفشل الكتابة يُعلن 500 لا يُبتلع.
 * * الاستجابة: التكوين الفعلي بعد الدمج (إعدادات مقروءة ⇒ فوقها التجاوز)
 *   — بلا أسرار ولا مسارات مطلقة.
 */

const noStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
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
    return noStore({ message: "تكوين النسخ الدائم للمدير وحده." }, 403);
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

  const parsed = parseVolumeBackupConfigPatch(body);
  if (!parsed.ok) {
    return noStore({ message: "قيم تكوين غير صالحة — القائمة بيضاء والحدود صارمة." }, 400);
  }

  const volumeRoot = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ?? "";
  if (!volumeRoot || !path.isAbsolute(volumeRoot)) {
    return noStore({ message: "وجهة النسخ غير مضبوطة." }, 503);
  }
  const documents = await storageStatus();
  if (!documents.ready || !documents.directory) {
    return noStore({ message: "تخزين المستندات غير جاهز." }, 503);
  }
  try {
    assertDocumentsDirInsideVolume(documents.directory, volumeRoot);
  } catch {
    return noStore({ message: "دليل المستندات خارج جذر القرص الدائم." }, 503);
  }
  let backupDir: string;
  try {
    backupDir = resolveBackupDirectory(volumeRoot);
  } catch {
    return noStore({ message: "وجهة النسخ غير مضبوطة." }, 503);
  }

  try {
    await writeVolumeBackupConfig(backupDir, parsed.patch);
  } catch {
    return noStore({ message: "تعذّرت كتابة التكوين على القرص الدائم." }, 500);
  }

  // الحالة الفعلية بعد الكتابة: إعدادات مقروءة ⇒ فوقها التجاوز؛ غير مقروءة
  // ⇒ الافتراضيات فوقها التجاوز (المعطى الوحيد هنا هو التجاوز نفسه).
  const override = await readVolumeBackupConfig(backupDir);
  const settingsRead = await getBackupSettingsReadOnly();
  const effective = mergeBackupRunConfig(
    resolveBackupRunConfig(settingsRead.ok ? settingsRead.settings : ({} as Parameters<typeof resolveBackupRunConfig>[0])),
    override.status === "present" ? override.patch : {},
  );

  return noStore({
    ok: true,
    written: parsed.patch,
    configSource: {
      settingsReadable: settingsRead.ok,
      volumeOverride: override.status,
    },
    effective: {
      backupEnabled: effective.backupEnabled,
      scheduleEnabled: effective.scheduleEnabled,
      scheduleTime: effective.scheduleTime,
      scheduleTimeZone: effective.scheduleTimeZone,
      retentionDailyCount: effective.retentionDailyCount,
      retentionWeeklyCount: effective.retentionWeeklyCount,
      destinations: effective.destinations,
    },
  }, 200);
}

export async function GET() {
  return noStore({ message: "كتابة التكوين أمر POST حصرًا؛ الحالة من GET /api/settings/backup." }, 405);
}

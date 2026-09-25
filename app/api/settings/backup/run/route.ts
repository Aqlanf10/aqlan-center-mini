import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/roles";
import { requireBackupAdminReadOnly } from "@/lib/backupReadOnly";
import { runVerifiedManualBackup } from "@/lib/manual-backup";

export const dynamic = "force-dynamic";

/**
 * «نسخ الآن» يدوي قابل للتكرار — للمدير وحده، في أي وقت، لكل يومٍ يأتي.
 *
 * ### لماذا وُجدت نقطة ثانية إلى جانب بوابة التفعيل
 *
 * بوابة `/api/settings/production-backup` تفعيلُ لمرةٍ واحدة برمزٍ يُستنفد
 * بالاكتمال — وهذا عينُ ما يريده أول تفعيل موثَّق. أما المالك الذي أراد
 * نسخةً يدوية غدًا وبعد أسبوع فلهذه النقطة: **نفس** دورة المحرك
 * (triggerType="manual")، **نفس** القفل الذرّي، **نفس** التحقق الكامل،
 * **نفس** ضمانات القراءة-الحصر من القاعدة — بلا رمز لمرة واحدة يمنعها.
 *
 * ### القراءة حصرًا من القاعدة
 *
 * الجلسة: توقيع HMAC ثم SELECT مباشر لصف المستخدم (بلا ensureSchema).
 * الإعدادات: SELECT مباشر — جدول غائب أو غير مقروء ⇒ فشل مغلق 503: لا نسخة
 * ولا إصلاح مخطط. التجاوز الدائم (backup-config.json) تالف ⇒ 503.
 *
 * الاستجابة ملخّص معقّم: id بتسمية المحرك المعتمدة، تاريخ، بصمات، مقاس،
 * حالات الوجهات — لا مسارات مطلقة ولا أسرار ولا محتوى.
 */

const noStore = (body: unknown, status: number): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST() {
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
    return noStore({ message: "نسخ «الآن» اليدوي للمدير وحده." }, 403);
  }

  const result = await runVerifiedManualBackup();
  if (!result.ok) return noStore(result.body, result.status);
  return noStore({
    ok: true,
    backup: result.backup,
    replicationStatus: result.replicationStatus,
    destinations: result.destinations,
  }, 200);
}

export async function GET() {
  return noStore({ message: "نسخ «الآن» أمر POST حصرًا." }, 405);
}

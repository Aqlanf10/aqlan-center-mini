import { NextResponse } from "next/server";
import { connectionStringFromEnv, countUsers } from "@/lib/db";
import { storageStatus } from "@/lib/files";

export const dynamic = "force-dynamic";

/**
 * هل الأداة مضبوطة وجاهزة؟
 *
 * تُعيد **وجود** كل إعداد لا قيمته: لا رابط قاعدة ولا سرّ ولا رمز يخرج من هنا. الغرض
 * أن يعرف المالك — وأن أعرف أنا عن بُعد — أيّ متغيّر ناقص، بدل تخمين السبب من صفحة
 * بيضاء. بلا هذا المسار، «لماذا لا تعمل؟» تحتاج وصولًا إلى لوحة النشر.
 *
 * مفتوح بلا جلسة عمدًا: من يحتاجه هو من لا يستطيع الدخول بعد. وما يكشفه — أن إعدادًا
 * ناقص — لا يمنح مهاجمًا شيئًا لا يعرفه من محاولة الدخول نفسها.
 *
 * ويقول أيضًا أيّ نسخةٍ تعمل الآن. سؤال «هل وصل تعديلي إلى الموقع؟» كان يحتاج لوحة
 * النشر، فيُخمَّن الجواب أو يُنتظر بلا داعٍ. سبعة أحرفٍ من بصمة الإصدار تكفي للجواب
 * ولا تكشف شيئًا عن محتوى المستودع.
 */
export async function GET() {
  let hasDatabase = false;
  try {
    hasDatabase = Boolean(connectionStringFromEnv()) || (
      process.env.USE_LOCAL_DB === "true" && process.env.NODE_ENV !== "production" && !process.env.RAILWAY_PROJECT_ID
    );
  } catch { /* إعداد مشروع غير صالح: لا نعلن الجاهزية. */ }
  const secret = process.env.SESSION_SECRET ?? "";
  const hasSessionSecret = secret.length >= 32;
  const setupToken = process.env.SETUP_TOKEN ?? "";

  let databaseReachable: boolean | null = null;
  let adminExists: boolean | null = null;
  if (hasDatabase) {
    try {
      adminExists = (await countUsers()) > 0;
      databaseReachable = true;
    } catch {
      databaseReachable = false;
    }
  }

  const ready = hasDatabase && hasSessionSecret && databaseReachable === true;
  const missing = [
    !hasDatabase ? "DATABASE_URL" : null,
    !hasSessionSecret ? "SESSION_SECRET (32 حرفًا فأكثر)" : null,
  ].filter(Boolean);

  const revision = (process.env.RAILWAY_GIT_COMMIT_SHA ?? "").slice(0, 7);
  // تخزين الملفّات: غيابُه لا يمنع تشغيل البرنامج، لكنه يمنع رفع الأشعة — ويُقال
  // هنا كي يُكتشف قبل أن يحاول أحدٌ الرفع، لا بعده.
  const storage = await storageStatus();

  return NextResponse.json({
    ready,
    الإصدار: revision || "غير معروف",
    الناقص: missing,
    قاعدة_البيانات: hasDatabase ? (databaseReachable ? "متصلة" : "مضبوطة لكن لا تستجيب") : "غير مضبوطة",
    تخزين_الملفات: storage.ready ? "جاهز" : storage.message,
    سر_الجلسات: hasSessionSecret ? "مضبوط" : "ناقص أو قصير",
    الإعداد_الأول: setupToken.length >= 16
      ? (adminExists ? "مفعّل — لكن يوجد حساب، احذف SETUP_TOKEN" : "جاهز: افتح /setup")
      : (adminExists ? "منتهٍ" : "أضف SETUP_TOKEN لإنشاء أول حساب"),
  });
}

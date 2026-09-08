import { NextResponse } from "next/server";
import { connectionStringFromEnv, countUsers } from "@/lib/db";
import { probeStorageReadiness } from "@/lib/storage-readiness";

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
 *
 * (P1.17) فحص التخزين ترقّى من «هل مضبوط؟» إلى قرار المتانة الكامل
 * (lib/storage-readiness.ts): مسار مؤقّت/نسبي في الإنتاج = رفض صريح لا «جاهز»،
 * لأن الحاوية تُمحى عند أول إعادة نشر — والسقوط الصامت إلى ephemeral هو الخطر
 * الحقيقي هنا، لا غياب المتغير وحده.
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

  /* (P1-FIX-7) جاهزية الإنتاج تشمل التخزين الدائم: مستندات على نظام ملفات
     غير موثَّق الدوام = غير جاهز — أول إعادة نشر تمحو أشعة المرضى. */
  const storage = await probeStorageReadiness();
  const storageBlocksReadiness = storage.production && !storage.durable;
  const ready = hasDatabase && hasSessionSecret && databaseReachable === true && !storageBlocksReadiness;
  const missing = [
    !hasDatabase ? "DATABASE_URL" : null,
    !hasSessionSecret ? "SESSION_SECRET (32 حرفًا فأكثر)" : null,
    storageBlocksReadiness ? "تخزين مستندات دائم (DOCUMENTS_DIR داخل جذر durable موثَّق — RAILWAY_VOLUME_MOUNT_PATH داخل Railway، أو DURABLE_STORAGE_ROOT خارجها، أو قرص مثبت فعليًّا)" : null,
  ].filter(Boolean);

  const revision = (process.env.RAILWAY_GIT_COMMIT_SHA ?? "").slice(0, 7);

  return NextResponse.json({
    ready,
    الإصدار: revision || "غير معروف",
    الناقص: missing,
    قاعدة_البيانات: hasDatabase ? (databaseReachable ? "متصلة" : "مضبوطة لكن لا تستجيب") : "غير مضبوطة",
    تخزين_الملفات: storage.durable ? "جاهز ودائم" : storage.reasons[0] ?? "غير جاهز",
    سر_الجلسات: hasSessionSecret ? "مضبوط" : "ناقص أو قصير",
    الإعداد_الأول: setupToken.length >= 16
      ? (adminExists ? "مفعّل — لكن يوجد حساب، احذف SETUP_TOKEN" : "جاهز: افتح /setup")
      : (adminExists ? "منتهٍ" : "أضف SETUP_TOKEN لإنشاء أول حساب"),
  });
}

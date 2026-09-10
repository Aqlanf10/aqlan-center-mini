import { NextResponse } from "next/server";
import { connectionStringFromEnv, countUsers } from "@/lib/db";
import { probeStorageReadiness } from "@/lib/storage-readiness";

export const dynamic = "force-dynamic";

/**
 * جاهزية minimal — قراءة لا تشخيص (P2/S11).
 *
 * هذا المسار يعود لفاحص المنصة (Railway health check) وأي عابر: يعطي
 * **قرار الجاهزية وحده** — 200 جاهز أو 503 غير جاهز — ولا شيء غيره.
 *
 * ما كان يخرج من هنا سابقًا (نسخة الإصدار، حالة القاعدة والسر، حالة السرّ،
 * حالة الإعداد الأول وهل يوجد مدير) انتقل إلى `/api/settings/readiness`
 * للمدير وحده: هذه تفاصيل تشغيلية، ونشرها لكل عابر يمنح من يريد اختبار
 * أبوابنا خريطةً لما ينقص — دون أن تشتري لفاحص الجاهزية شيئًا لا يحتاجه.
 *
 * الحد الفاصل مقصود: نحسب الجاهزية نفسها بالكامل (اتصال مضبوط + سرّ جلسات
 * + قاعدة تستجيب + تخزين دائم في الإنتاج)، لكن المتصفح يرى الحكم النهائي
 * فقط. البقاء بجسم متطابق مهما اختلف سبب عدم الجاهزية — لا تلميحات.
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

  let databaseReachable: boolean | null = null;
  if (hasDatabase) {
    try {
      await countUsers();
      databaseReachable = true;
    } catch {
      databaseReachable = false;
    }
  }

  /* (P1-FIX-7) جاهزية الإنتاج تشمل التخزين الدائم — القرار يُحسب هنا ولا
     سببه يخرج: تفاصيل التشخيص في مسار المدير. */
  const storage = await probeStorageReadiness();
  const storageBlocksReadiness = storage.production && !storage.durable;
  const ready = hasDatabase && hasSessionSecret && databaseReachable === true && !storageBlocksReadiness;

  if (!ready) {
    return NextResponse.json({ ready: false }, { status: 503 });
  }
  return NextResponse.json({ ready: true }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}

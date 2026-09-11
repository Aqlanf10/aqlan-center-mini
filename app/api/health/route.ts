import { NextResponse } from "next/server";
import { connectionStringFromEnv, getPool } from "@/lib/db";
import { probeStorageReadiness } from "@/lib/storage-readiness";
import { logSchemaRegistrationPreflightOnce } from "@/lib/schema-preflight";
import { logSchemaBaselineVerifyOnce } from "@/lib/schema-baseline-verify";

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
 * Final Production Gate: فحص وصول القاعدة هنا هو SELECT 1 مباشر، لا countUsers
 * ولا أي دالة أعمال قد تستدعي ensureSchema. healthcheck نفسه لا يجوز أن يكون
 * سببًا في CREATE/ALTER ضمن قاعدة الإنتاج.
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
      const pool = getPool();
      await pool.query("SELECT 1");
      databaseReachable = true;
      await logSchemaRegistrationPreflightOnce(pool);
      /* Final Production Gate: تحقق خط الأساس بـSELECT فقط — one-shot محمي
         بعلم صريح، لا يغيّر هذا الجواب ولا يرمي أخطاء، وتفاصيله لا تخرج هنا. */
      await logSchemaBaselineVerifyOnce(pool);
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

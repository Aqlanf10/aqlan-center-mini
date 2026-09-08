import { Client, Pool } from "pg";

/**
 * إعداد اختبارات PostgreSQL الحقيقية (P1.3) — مشترك لكل ملفات __tests__/postgres.
 *
 * المتغيرات:
 *  * TEST_DATABASE_URL (الأولوية) أو DATABASE_URL — قاعدة PostgreSQL حقيقية.
 *  * المتغيرات القياسية للعزل: NODE_ENV=test، بلا USE_LOCAL_DB، بلا Railway.
 *
 * فشل الاتصال برسالة إعداد صريحة = فشل الاختبار (fail-closed): التزامن لا يُثبت
 * إلا على قاعدة حقيقية، والإسكات الاختياري يهدم الغرض.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";

export function assertRealPostgresUrl(): string {
  if (!TEST_DATABASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL أو DATABASE_URL غير مضبوط — اختبارات PostgreSQL الحقيقية "
      + "تحتاج قاعدة فعلية. محليًّا: ثبّت PostgreSQL وشغّل "
      + "TEST_DATABASE_URL=postgresql://ci@127.0.0.1:5432/aqlan_p1_test?sslmode=disable npm run test:postgres",
    );
  }
  if (process.env.USE_LOCAL_DB === "true") {
    throw new Error("USE_LOCAL_DB=true مع اختبارات PostgreSQL الحقيقية تناقض — أزل PGlite.");
  }
  return TEST_DATABASE_URL;
}

/** إعداد بيئة الاتصال قبل استيراد وحدات التطبيق (db.ts تقرأها عند الإنشاء). */
export function stubPostgresEnv(): void {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = TEST_DATABASE_URL;
  delete process.env.USE_LOCAL_DB;
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  delete process.env.RAILWAY_PROJECT_ID;
  delete process.env.SKIP_SEED;
}

/** اتصال إداري مباشر (بمعاملات التطبيق) — لإنشاء/إسقاط قواعد العزل. */
export function adminClient(database: string): Client {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return new Client({ connectionString: url.toString(), ssl: false });
}

/** قاعدة بيانات معزولة جديدة للاختبار (تُسقط إن وُجدت — بيئة اختبار فقط). */
export async function createIsolatedDatabase(name: string): Promise<string> {
  const admin = adminClient("postgres");
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/** إعادة المخطط إلى الصفر — بيئة اختبار فقط، ممنوع على أي شيء غير معزول. */
export async function dropPublicSchema(connectionString: string): Promise<void> {
  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
}

/** pool خام مستقل عن التطبيق — لإثبات سباقات عبر اتصالات مختلفة فعلًا. */
export function rawPool(connectionString: string = TEST_DATABASE_URL, max = 5): Pool {
  return new Pool({ connectionString, ssl: false, max });
}

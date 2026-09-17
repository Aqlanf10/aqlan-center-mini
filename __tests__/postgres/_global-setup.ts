import { Client } from "pg";
import {
  SUPPORTED_POSTGRES_MAJOR,
  assertPostgresMajorOrThrow,
  postgresMajorFromVersionNum,
} from "../../lib/env-contract";

/**
 * إعداد اختبارات PostgreSQL الحقيقية — فحص إصدار الخادم مرةً قبل كل الملفات.
 *
 * قبل هذا الفحص كانت البوابة تقبل أي إصدار PostgreSQL يصادف المتغير: من يثبّت
 * 16 محليًّا يرى «كل الاختبارات نجحت» بينما CI يفرض 18 وعقد المخطط يُولَّد على
 * 18 حصرًا — وهذا بالضبط انجرافُ TD-REG-008. الآن الإصدار الخاطئ يفشل **بوضوح**
 * من أول الملفات، قبل أي جدول أو بيانات: رسالةٌ تحمل الإصدارَ الحالي والعقدَ
 * وطريق التشغيل المحلي الموثَّق.
 *
 * يُشغَّل من vitest.config.postgres.mts (globalSetup) — مرة واحدة للجولة كلها.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const url = process.env.TEST_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL أو DATABASE_URL غير مضبوط — اختبارات PostgreSQL الحقيقية "
      + "تحتاج قاعدة فعلية. الطريق المحلي الموثَّق (PostgreSQL "
      + `${SUPPORTED_POSTGRES_MAJOR}): docker compose up -d pg18 ثم `
      + "TEST_DATABASE_URL=postgresql://ci:ci@127.0.0.1:54329/aqlan_p1_test?sslmode=disable npm run test:postgres",
    );
  }
  const client = new Client({ connectionString: url, ssl: false });
  await client.connect();
  try {
    const { rows } = await client.query<{ server_version_num: string }>(
      "SELECT current_setting('server_version_num') AS server_version_num",
    );
    const major = postgresMajorFromVersionNum(rows[0]?.server_version_num ?? 0);
    assertPostgresMajorOrThrow(major);
    const { rows: versionRows } = await client.query<{ server_version: string }>(
      "SELECT current_setting('server_version') AS server_version",
    );
    console.log(
      `✓ عقد PostgreSQL مستوفى — الخادم ${versionRows[0]?.server_version ?? "?"} (major ${major} = عقد الاختبار/التطوير).`,
    );
  } finally {
    await client.end();
  }
  return async () => {};
}

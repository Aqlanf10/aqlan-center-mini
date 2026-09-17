import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * إعداد اختبارات تكامل PostgreSQL الحقيقية (P1.3).
 *
 * منفصلة عن اختبارات الوحدة عمدًا:
 *  * تشغيلها: npm run test:postgres
 *  * تتطلب قاعدة PostgreSQL حقيقية عبر TEST_DATABASE_URL (أو DATABASE_URL).
 *  * فشل الاتصال = فشل الاختبار برسالة إعداد واضحة — الاختبار الاختياري
 *    (skip) يهزم الغرض: التزامن لا يُثبت إلا على قاعدة حقيقية.
 *  * في CI تعمل ضد PostgreSQL service container إلزاميًّا.
 *  * (TD-02/TD-REG-008) عقد الإصدار: major المدعوم 18 حصرًا — يُفحص مرةً
 *    واحدة قبل كل الملفات في _global-setup.ts، فيفشل الإصدارُ الآخر فشلًا
 *    صريحًا لا نجاحًا صامتًا على قاعدةٍ لا يفرضها CI أصلاً.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["__tests__/postgres/**/*.test.ts"],
    globalSetup: ["__tests__/postgres/_global-setup.ts"],
    pool: "forks",
    fileParallelism: false,
    maxConcurrency: 1,
    forks: {
      singleFork: true,
    },
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});

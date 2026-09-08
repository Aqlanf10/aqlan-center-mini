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
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["__tests__/postgres/**/*.test.ts"],
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

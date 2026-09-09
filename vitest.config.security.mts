import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * إعداد اختبارات الأمن على HTTP الحقيقي (P2/S14).
 *
 * يشغّل تطبيقًا **مبنيًّا فعلًا** (next build ثم standalone server) على قاعدة
 * PostgreSQL معزولة — لا PGlite ولا بيانات إنتاج:
 *  * التشغيل: npm run build ثم npm run test:security-http
 *  * تتطلب TEST_DATABASE_URL (أو DATABASE_URL) لقاعدة حقيقية — ينشئ المستعبِر
 *    قاعدة معزولة خاصة بها (aqlan_sec_http) ويسقطها بعد الانتهاء.
 *  * إلزامية في CI — ليست اختيارية: رؤوس الأمن وCSP وCSRF وحدود الأجسام
 *    ومصفوفة RBAC لا تُثبت إلا على طلب HTTP حقيقي عبر التطبيق المبني.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // الخادم يبدأ مرة واحدة لكل الجولة (لا لكل ملف) — التوكنات تبقى صالحة
    // بين الملفات، وإيقافه/إسقاط القاعدة في التفكيك العالمي.
    globalSetup: ["__tests__/security-http/_global-setup.ts"],
    include: ["__tests__/security-http/**/*.test.ts"],
    pool: "forks",
    fileParallelism: false,
    maxConcurrency: 1,
    forks: {
      singleFork: true,
    },
    // مستعبِر الخادم مفرد عبر الملفات كلها: بلا إعادة استيراد لكل ملف —
    // إعادة التهيئة كانت تُسقط القاعدة تحت خادم الجولة السابقة.
    isolate: false,
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});

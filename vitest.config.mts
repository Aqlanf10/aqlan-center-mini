import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    // اختبارات تكامل PostgreSQL الحقيقية منفصلة عمدًا (P1.3): تُشغَّل عبر
    // `npm run test:postgres` بإعدادها الخاص وتتطلب قاعدة حقيقية — لا تدخل
    // في `npm test` (وحدة) الذي يعمل بلا قاعدة.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "__tests__/postgres/**",
      // (P2/S14) اختبارات الأمن HTTP بإعدادها المستقل — تشغّلها
      // npm run test:security-http على تطبيق مبنيّ وقاعدة حقيقية.
      "__tests__/security-http/**",
    ],
    pool: "forks",
    fileParallelism: false,
    maxConcurrency: 1,
    forks: {
      singleFork: true,
    },
  },
});

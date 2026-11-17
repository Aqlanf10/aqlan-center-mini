import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: [
 { find: "@", replacement: fileURLToPath(new URL(".", import.meta.url)) },
 { find: /^server-only$/, replacement: fileURLToPath(new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url)) },
] }, test: { include: ["__tests__/security-http/retired-0079-journal-browser.test.ts"], pool: "forks", fileParallelism: false, testTimeout: 120000, hookTimeout: 300000 } });

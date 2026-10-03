import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Explicit local PDF fixture only. No app server, DB, migrations or real signatures.
// Run separately when Chromium + Poppler are available and the runtime window is granted.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["__tests__/security-http/consent-print-pagination-fixture.test.tsx"],
    pool: "forks", fileParallelism: false, maxWorkers: 1, testTimeout: 120_000,
  },
});

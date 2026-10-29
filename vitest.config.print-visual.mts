import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Isolated hosted Chromium/PDF presentation smoke. Synthetic inputs only;
 * deliberately separate from built-app HTTP/DB authorization acceptance. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    include: ["__tests__/print-visual/official-installment-contract.test.tsx"],
    pool: "forks",
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

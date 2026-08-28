import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(import.meta.dirname, "./src") };

export default defineConfig({
  test: {
    environment: "node",
    reporters: ["default"],
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
        resolve: { alias },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["./tests/integration/global-setup.ts"],
          testTimeout: 180_000,
          hookTimeout: 180_000,
          // Real PostgreSQL per run; one integration file at a time.
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          minWorkers: 1,
        },
        resolve: { alias },
      },
    ],
  },
  resolve: { alias },
});

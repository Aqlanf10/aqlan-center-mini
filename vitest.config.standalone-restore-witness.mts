import { defineConfig } from "vitest/config";
import base from "./vitest.config.postgres.mts";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      "__tests__/postgres/standalone-real-restore.witness.ts",
      "__tests__/postgres/allocator-archive.witness.ts",
    ],
    globalSetup: ["__tests__/postgres/_standalone-restore-witness-setup.ts"],
  },
});

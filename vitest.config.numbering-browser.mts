import { defineConfig } from "vitest/config";
import postgres from "./vitest.config.postgres.mts";
export default defineConfig({
  ...postgres, test: { ...postgres.test, include: ["__tests__/numbering-browser/*.test.ts"] },
});

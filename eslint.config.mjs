import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...next,
  ...nextTypescript,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "drizzle/**",
    "node_modules/**",
  ]),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
]);

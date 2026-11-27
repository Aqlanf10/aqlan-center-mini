import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// This rehearsal needs a separate authority database. Run it explicitly, outside clinic CI.
const root = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig({
  root,
  resolve: { alias: { "@": root } },
  test: {
    include: ["__tests__/postgres/owner-proof-authority.rehearsal.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

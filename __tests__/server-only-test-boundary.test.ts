import { createRequire } from "node:module";
import { expect, it } from "vitest";
// Staging wave 1 adaptation: the original target (lib/inventory-domain/reference-transport) belongs to
// the excluded partial inventory recovery; any real `import "server-only"` module proves the alias.
import { summarizeStaffAuthoritySnapshot } from "../lib/staff-authority-snapshot";

it("loads a real marked server module under the test-only exact alias", () => {
  expect(typeof summarizeStaffAuthoritySnapshot).toBe("function");
});
it("retains the real production client-boundary poison module", () => {
  const require = createRequire(import.meta.url);
  expect(() => require("../node_modules/next/dist/compiled/server-only/index.js"))
    .toThrow("This module cannot be imported from a Client Component module");
});

import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { createReferenceTransport } from "../lib/inventory-domain/reference-transport";

it("loads a real marked server module under the test-only exact alias", () => {
  expect(typeof createReferenceTransport).toBe("function");
});
it("retains the real production client-boundary poison module", () => {
  const require = createRequire(import.meta.url);
  expect(() => require("../node_modules/next/dist/compiled/server-only/index.js"))
    .toThrow("This module cannot be imported from a Client Component module");
});

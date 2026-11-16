import { describe, expect, it } from "vitest";
import { build } from "esbuild";

/**
 * lib/db.ts is imported by plain Node children (tsx): the isolated HR/lab/leadership HTTP
 * servers bootstrap their schema that way, as do operational scripts. `server-only` exists
 * only inside Next and vitest, so any module in db.ts's static graph that imports it breaks
 * those children ("Cannot find module 'server-only'"; CI run 40612201316). Server-only
 * protection belongs to modules outside this graph.
 */
describe("lib/db.ts static import graph", () => {
 it("never reaches the Next-only `server-only` marker", async () => {
  const result = await build({ entryPoints: ["lib/db.ts"], bundle: true, platform: "node", write: false, metafile: true, logLevel: "silent", packages: "external" });
  const importers = Object.entries(result.metafile.inputs).flatMap(([file, input]) => input.imports.some(entry => entry.path === "server-only") ? [file] : []);
  expect(importers).toEqual([]);
 }, 60_000);
});

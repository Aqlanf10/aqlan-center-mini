import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "", resolved: "" }));
vi.mock("esbuild", async (original) => {
  const actual = await original<typeof import("esbuild")>();
  return { ...actual, build: (options: import("esbuild").BuildOptions) => actual.build({
    ...options,
    plugins: [{ name: "outside-package-symlink-witness", setup(build) {
      build.onResolve({ filter: /^pg$/ }, async (args) => {
        if (args.pluginData?.witness) return;
        const result = await build.resolve("pg", {
          resolveDir: fixture.root, kind: "import-statement", pluginData: { witness: true },
        });
        fixture.resolved = result.path;
        return result;
      });
    } }, ...(options.plugins ?? [])],
  }) };
});
import { buildPreflightArtifact } from "../scripts/build-preflight";

afterEach(async () => {
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true });
  fixture.root = ""; fixture.resolved = "";
});

it("refuses an allowed-looking package symlink whose physical source is outside reviewed modules", async () => {
  fixture.root = await mkdtemp(path.join(tmpdir(), "aqlan-preflight-physical-"));
  const outside = path.join(fixture.root, "unreviewed-app");
  await mkdir(outside);
  await mkdir(path.join(fixture.root, "node_modules"));
  await writeFile(path.join(outside, "package.json"), JSON.stringify({ name: "pg", version: "0.0.0-synthetic", main: "index.js" }));
  await writeFile(path.join(outside, "index.js"), "module.exports = { Client: class SyntheticClient {} };\n");
  await symlink(outside, path.join(fixture.root, "node_modules/pg"), "dir");
  await expect(buildPreflightArtifact(path.join(fixture.root, "preflight")))
    .rejects.toThrow("Preflight artifact imported an unreviewed application module.");
  expect(fixture.resolved).toBe(path.join(outside, "index.js"));
});

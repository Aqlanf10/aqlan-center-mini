import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { verifyRuntimeArtifacts } from "../scripts/verify-braces-runtime.mjs";
import { sha256 } from "../scripts/dependency-security/installed-braces.mjs";
let root;
const put = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
const json = async (file, value) => put(file, JSON.stringify(value));
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "braces-runtime-test-"));
  await json("package.json", { name: "synthetic", devDependencies: { braces: "file:vendor/braces-3.0.3-local.tgz" } });
  await put("package-lock.json", "{}\n");
  await put(".next/BUILD_ID", "synthetic-build");
  await put(".next/standalone/server.js", "console.log('fixture');\n");
  await json(".next/standalone/package.json", { name: "synthetic", devDependencies: { braces: "file:vendor/braces-3.0.3-local.tgz" } });
  await json(".next/next-server.js.nft.json", { version: 1, files: ["../package.json"] });
  await put(".next/server/chunk.js", "console.log('fixture');\n");
  await json(".next/server/chunk.js.nft.json", { version: 1, files: ["chunk.js"] });
  await json(".next/standalone/chunk.js.map", { version: 3, sources: ["app/page.tsx"], sourcesContent: ["export const safe = true;"], mappings: "" });
  await put(".next/static/chunk.js", "console.log('static');\n");
  await put(".preflight/runner/run.mjs", "console.log('preflight');\n");
  await put(".preflight/THIRD_PARTY_NOTICES.txt", "fixture notice\n");
  await json(".preflight/manifest.json", { format: "aqlan-read-only-preflight-artifact", formatVersion: 2,
    bundledPackages: [{ name: "pg", version: "8.20.0" }], bundleSha256: sha256("console.log('preflight');\n"), noticesSha256: sha256("fixture notice\n") });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe("actual shipped runtime artifact proof", () => {
  it("requires all three artifacts and binds exact files; root dev declaration is not an installed copy", async () => {
    const proof = await verifyRuntimeArtifacts(root);
    expect(proof.traceCount).toBe(2); expect(proof.sourceMapCount).toBe(1); expect(proof.lockSha256).toBe(sha256("{}\n"));
  });
  it.each([".next/standalone/server.js", ".next/BUILD_ID", ".next/next-server.js.nft.json", ".preflight/manifest.json", ".preflight/runner/run.mjs", ".next/static"])("fails if required artifact is missing: %s", async (file) => {
    await rm(path.join(root, file), { recursive: true }); await expect(verifyRuntimeArtifacts(root)).rejects.toThrow();
  });
  it.each([
    ["installed runtime copy", async () => json(".next/standalone/node_modules/braces/package.json", { name: "braces", version: "3.0.3" })],
    ["renamed directory with braces identity", async () => json(".next/standalone/node_modules/other/package.json", { name: "braces", version: "3.0.3" })],
    ["direct bundled import", async () => put(".next/static/chunk.js", "require('braces')")],
    ["known patched code identity", async () => put(".next/static/chunk.js", "throw new Error('BRACES_NESTING_LIMIT')")],
    ["runtime trace source", async () => json(".next/server/chunk.js.nft.json", { version: 1, files: ["../../node_modules/braces/index.js"] })],
    ["source-map input", async () => json(".next/standalone/chunk.js.map", { version: 3, sources: ["node_modules/braces/index.js"] })],
    ["sourceRoot input", async () => json(".next/standalone/chunk.js.map", { version: 3, sourceRoot: "node_modules/braces", sources: ["index.js"] })],
    ["preflight changed bytes", async () => put(".preflight/runner/run.mjs", "changed")],
    ["preflight bundled braces", async () => { const m = JSON.parse(await readFile(path.join(root, ".preflight/manifest.json"), "utf8")); m.bundledPackages.push({ name: "braces", version: "3.0.3" }); await json(".preflight/manifest.json", m); }],
  ])("blocks %s", async (_label, change) => { await change(); await expect(verifyRuntimeArtifacts(root)).rejects.toThrow(); });
  it.each(["braces", "braces.js", "braces.json", "braces.node"])("rejects shipped file-shadow %s", async (name) => {
    await put(`.next/standalone/node_modules/consumer/lib/node_modules/${name}`, "{}\n"); await expect(verifyRuntimeArtifacts(root)).rejects.toThrow();
  });
});

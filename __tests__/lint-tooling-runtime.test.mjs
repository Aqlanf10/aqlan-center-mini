import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { verifyLintToolingRuntime, verifyProductionToolingGraph, toolingSourcePath } from "../scripts/dependency-security/verify-lint-tooling-runtime.mjs";
import { sha256 } from "../scripts/dependency-security/installed-braces.mjs";
let root;
const put = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
const json = async (file, value) => put(file, JSON.stringify(value));
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "lint-tooling-runtime-test-"));
  const pkg = { name: "synthetic-runtime", dependencies: { pg: "8.20.0" }, devDependencies: { eslint: "10.14.0", "eslint-plugin-react-hooks": "7.1.1" } };
  await json("package.json", pkg); await json("package-lock.json", {});
  await put(".next/BUILD_ID", "synthetic-build");
  await put(".next/standalone/server.js", "console.log('safe');\n");
  await json(".next/standalone/package.json", pkg);
  await json(".next/next-server.js.nft.json", { version: 1, files: ["../package.json"] });
  await put(".next/server/chunk.js", "console.log('server');\n");
  await json(".next/server/chunk.js.nft.json", { version: 1, files: ["chunk.js"] });
  await json(".next/standalone/chunk.js.map", { version: 3, sources: ["app/page.tsx"], sourcesContent: ["export const safe = true;"], mappings: "" });
  await put(".next/static/chunk.js", "console.log('client');\n");
  await put(".preflight/runner/run.mjs", "console.log('preflight');\n");
  await put(".preflight/THIRD_PARTY_NOTICES.txt", "fixture notice\n");
  await json(".preflight/manifest.json", { format: "aqlan-read-only-preflight-artifact", formatVersion: 2,
    bundledPackages: [{ name: "pg", version: "8.20.0" }], bundleSha256: sha256("console.log('preflight');\n"), noticesSha256: sha256("fixture notice\n") });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const names = ["minimatch", "eslint", "eslint-plugin-react-hooks", "typescript-eslint", "@eslint/js", "@eslint-community/eslint-utils", "@typescript-eslint/parser"];
describe("strict additive lint tooling runtime evidence", () => {
  it("accepts clean byte-bound artifacts; root dev metadata is not a shipped tooling copy", async () => {
    const proof = await verifyLintToolingRuntime(root);
    expect(proof.buildId).toBe("synthetic-build"); expect(proof.traceCount).toBe(2);
    expect(proof.checkedRoots).toEqual([".next/standalone", ".next/static", ".preflight"]);
    expect(proof.sourceMapCount).toBe(1); expect(proof.productionGraph).toBeNull();
    expect(proof.mapCoverage).toContain("not proven absent");
    expect(proof.files[".next/static/chunk.js"]).toBe(sha256("console.log('client');\n"));
  });
  it.each(names)("rejects canonical identity %s even in an innocuous renamed shipped folder", async name => {
    await json(".next/standalone/node_modules/renamed/package.json", { name, version: "1.0.0" });
    await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/tooling package identity/);
  });
  it.each(names)("rejects NFT-only package %s including renamed directories", async name => {
    await json("node_modules/renamed/package.json", { name, version: "1.0.0" });
    await put("node_modules/renamed/index.js", "exports.safe = true;");
    await json(".next/server/chunk.js.nft.json", { version: 1, files: ["../../node_modules/renamed/index.js"] });
    await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/tooling trace package/);
  });
  it.each(["node_modules/minimatch/dist/index.js", "webpack:///./node_modules/@typescript-eslint/parser/index.js", "C:\\project\\node_modules\\eslint\\index.js", "node_modules/%65slint-plugin-react-hooks/index.js", "node_modules/minimatch/../other/index.js"])("rejects source-map-only input %s", async source => {
    await json(".next/standalone/chunk.js.map", { version: 3, sources: [source], mappings: "" });
    await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/tooling source-map input/);
  });
  it("inspects nested indexed source maps and joined scoped roots", async () => {
    await json(".next/standalone/chunk.js.map", { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sourceRoot: "webpack:///node_modules/@typescript-eslint", sources: ["parser/index.js"], mappings: "" } }] });
    await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/tooling/);
  });
  it("rejects a tooling artifact path even with a disguised manifest identity", async () => {
    await json(".next/standalone/node_modules/minimatch/package.json", { name: "disguised", version: "1" });
    await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/tooling artifact path/);
  });
  it("rejects preflight tooling input without weakening bundle-byte binding", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, ".preflight/manifest.json"), "utf8"));
    manifest.bundledPackages.push({ name: "minimatch", version: "11.0.3" }); await json(".preflight/manifest.json", manifest);
    await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/tooling preflight/);
  });
  it.each([".next/BUILD_ID", ".next/standalone", ".next/static", ".preflight/manifest.json", ".next/server/chunk.js.nft.json"])("fails closed on missing expected artifact %s", async file => {
    await rm(path.join(root, file), { recursive: true }); await expect(verifyLintToolingRuntime(root)).rejects.toThrow();
  });
  it.each([
    [".next/server/chunk.js.nft.json", { version: 1, files: [] }],
    [".next/standalone/package.json", { name: 4 }],
    [".next/standalone/chunk.js.map", { version: 3, sources: "not-an-array", mappings: "" }],
    [".next/standalone/chunk.js.map", { version: 3, sections: [{ url: "https://invalid.example/map" }] }],
  ])("fails closed on malformed inspected metadata %s", async (file, value) => {
    await json(file, value); await expect(verifyLintToolingRuntime(root)).rejects.toThrow();
  });
  it("retains the unchanged alias guard's rejection of unreviewed links", async () => {
    await symlink("../../package.json", path.join(root, ".next/standalone/unknown-link"));
    await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/alias/);
  });
  it("rejects trace traversal outside the project", async () => {
    await json(".next/server/chunk.js.nft.json", { version: 1, files: ["../../../../outside.js"] });
    await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/escapes project/);
  });
});
describe("read-only production npm graph", () => {
  it("accepts actual dependency edges rather than counting root dev declarations", () => {
    const proof = verifyProductionToolingGraph({ name: "synthetic", dependencies: { pg: { version: "8.20.0", dependencies: { "pg-pool": { version: "3.10.1" } } } } });
    expect(proof.packageOccurrences).toBe(2); expect(proof.graphSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(names)("rejects %s at any production depth or canonical alias identity", name => {
    expect(() => verifyProductionToolingGraph({ dependencies: { safe: { dependencies: { [name]: { version: "1" } } } } })).toThrow(/production dependency graph/);
    expect(() => verifyProductionToolingGraph({ dependencies: { renamed: { name, version: "1" } } })).toThrow(/production dependency graph/);
  });
  it.each([{}, { dependencies: {} }, { dependencies: [] }, { dependencies: { bad: { invalid: true } } }, { dependencies: { bad: { problems: ["missing"] } } }])("rejects missing/invalid/empty graph %#", graph => {
    expect(() => verifyProductionToolingGraph(graph)).toThrow();
  });
  it("fails closed for malformed percent encoding", () => { expect(() => toolingSourcePath("node_modules/%ZZ/index.js")).toThrow(); });
});

it("runs the separate strict verifier after both independent CI builds and Docker assembly", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const command = "node scripts/dependency-security/verify-lint-tooling-runtime.mjs";
  for (const job of [workflow.slice(workflow.indexOf("  quality:"), workflow.indexOf("  postgres_integration:")), workflow.slice(workflow.indexOf("  security_http:"), workflow.indexOf("  contract_print_visual:"))]) {
    expect(job.indexOf(command)).toBeGreaterThan(job.indexOf("npm run build:preflight"));
    expect(job.indexOf("npm run build:preflight")).toBeGreaterThan(job.indexOf("run: npm run build\n"));
    expect(job.indexOf(command)).toBeGreaterThan(job.indexOf("node scripts/verify-braces-runtime.mjs"));
  }
  const docker = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  expect(docker.indexOf(`RUN ${command}`)).toBeGreaterThan(docker.indexOf("RUN node scripts/verify-braces-runtime.mjs"));
  expect(docker.indexOf("RUN node scripts/verify-braces-runtime.mjs")).toBeGreaterThan(docker.indexOf("RUN npm run build:preflight"));
});

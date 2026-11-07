import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { verifyLintToolingRuntime } from "../scripts/dependency-security/verify-lint-tooling-runtime.mjs";
import { sha256 } from "../scripts/dependency-security/installed-braces.mjs";

const observed = vi.hoisted(() => ({ calls: [], hook: null }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal();
  const wrapped = { ...actual };
  for (const operation of ["lstat", "readFile", "realpath"]) {
    wrapped[operation] = async (...args) => {
      observed.calls.push([operation, String(args[0])]);
      try {
        const result = await actual[operation](...args);
        await observed.hook?.(operation, String(args[0]), result, null, actual);
        return result;
      } catch (error) {
        await observed.hook?.(operation, String(args[0]), null, error, actual);
        throw error;
      }
    };
  }
  return wrapped;
});

let root;
const put = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
const json = async (file, value) => put(file, JSON.stringify(value));
beforeEach(async () => {
  observed.calls = []; observed.hook = null;
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
afterEach(async () => { observed.hook = null; await rm(root, { recursive: true, force: true }); });

async function repeatedInputs(count = 20) {
  await json("node_modules/renamed/package.json", { name: "safe", version: "1" });
  await put("node_modules/renamed/lib/deep/input.js", "module.exports = {};\n");
  await json(".next/server/chunk.js.nft.json", { version: 1,
    files: Array(count).fill("../../node_modules/renamed/lib/deep/input.js") });
  return path.join(root, "node_modules/renamed/package.json");
}
it("checks each physical ancestor once plus a final byte recheck, without caching input realpaths", async () => {
  const manifest = await repeatedInputs();
  const input = path.join(root, "node_modules/renamed/lib/deep/input.js");
  observed.calls = [];
  await verifyLintToolingRuntime(root);
  expect(observed.calls.filter(([op, p]) => op === "readFile" && p === manifest)).toHaveLength(2);
  expect(observed.calls.filter(([op, p]) => op === "lstat" && p === manifest)).toHaveLength(2);
  expect(observed.calls.filter(([op, p]) => op === "realpath" && p === input)).toHaveLength(40);
});
it("does not retain safe manifest decisions across invocations", async () => {
  await repeatedInputs();
  await verifyLintToolingRuntime(root);
  await json("node_modules/renamed/package.json", { name: "eslint" });
  await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/tooling trace package/);
});
it.each(["identity", "malformed", "removed", "directory", "symlink"])("rejects persistent cached manifest mutation: %s", async kind => {
  const manifest = await repeatedInputs();
  let changed = false;
  observed.hook = async (op, file, _result, error, fs) => {
    if (changed || error || op !== "readFile" || file !== manifest) return;
    changed = true;
    if (kind === "identity") await fs.writeFile(manifest, JSON.stringify({ name: "eslint" }));
    if (kind === "malformed") await fs.writeFile(manifest, "{");
    if (["removed", "directory", "symlink"].includes(kind)) await fs.unlink(manifest);
    if (kind === "directory") await fs.mkdir(manifest);
    if (kind === "symlink") await fs.symlink(path.join(root, "package.json"), manifest);
  };
  await expect(verifyLintToolingRuntime(root)).rejects.toThrow();
  expect(changed).toBe(true);
});
it("rejects a previously absent ancestor manifest appearing during verification", async () => {
  await repeatedInputs();
  const manifest = path.join(root, "node_modules/renamed/lib/package.json");
  let changed = false;
  observed.hook = async (op, file, _result, error, fs) => {
    if (changed || op !== "lstat" || file !== manifest || error?.code !== "ENOENT") return;
    changed = true;
    await fs.writeFile(manifest, JSON.stringify({ name: "eslint" }));
  };
  await expect(verifyLintToolingRuntime(root)).rejects.toThrow();
  expect(changed).toBe(true);
});
it("does not reuse an ancestor decision for a different physical directory", async () => {
  await repeatedInputs();
  await json("node_modules/another/package.json", { name: "eslint" });
  await put("node_modules/another/input.js", "module.exports = {};\n");
  await json(".next/server/chunk.js.nft.json", { version: 1, files: [
    "../../node_modules/renamed/lib/deep/input.js", "../../node_modules/another/input.js"] });
  await expect(verifyLintToolingRuntime(root)).rejects.toThrow(/tooling trace package/);
});

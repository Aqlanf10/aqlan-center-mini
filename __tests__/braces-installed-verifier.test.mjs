import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { inspectInstalledBraces } from "../scripts/dependency-security/installed-braces.mjs";
import { BRACES_EXCEPTION as PIN } from "../lib/braces-exception-pins.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
let root;
const json = async (name, value) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), JSON.stringify(value)); };
const edit = async (name, fn) => { const data = JSON.parse(await readFile(path.join(root, name), "utf8")); fn(data); await json(name, data); };
async function addPackage(name, pkg) { await json(`node_modules/${name}/package.json`, pkg); await writeFile(path.join(root, `node_modules/${name}/index.js`), "module.exports = {};\n"); }

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "braces-verifier-test-"));
  await cp(path.join(repo, "vendor"), path.join(root, "vendor"), { recursive: true });
  const manifest = { name: "synthetic-verifier", version: "1.0.0", dependencies: { runtime: "1.0.0" }, devDependencies: { braces: "file:vendor/braces-3.0.3-local.tgz", consumer: "1.0.0" } };
  const upstreamManifest = JSON.parse(await readFile(path.join(root, "vendor/braces/package.json"), "utf8"));
  await json("package.json", manifest);
  await json("package-lock.json", { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
    "": manifest,
    "node_modules/braces": { version: PIN.version, resolved: "file:vendor/braces-3.0.3-local.tgz", integrity: PIN.candidateIntegrity, dev: true, dependencies: upstreamManifest.dependencies },
    "node_modules/consumer": { version: "1.0.0", dev: true, dependencies: { braces: "^3.0.3" } },
    "node_modules/fill-range": { version: "7.1.1", dev: true },
    "node_modules/runtime": { version: "1.0.0" },
  } });
  await cp(path.join(root, "vendor/braces"), path.join(root, "node_modules/braces"), { recursive: true });
  await addPackage("consumer", { name: "consumer", version: "1.0.0", dependencies: { braces: "^3.0.3" } });
  await addPackage("fill-range", { name: "fill-range", version: "7.1.1" });
  await addPackage("runtime", { name: "runtime", version: "1.0.0" });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("independent installed-source and runtime graph attestation", () => {
  it("verifies complete files and every consumer resolution while proving runtime graph absence", async () => {
    const proof = await inspectInstalledBraces(root);
    expect(proof.bracesPaths).toEqual(["node_modules/braces"]);
    expect(proof.consumers).toEqual([{ consumer: "", path: "node_modules/braces" }, { consumer: "node_modules/consumer", path: "node_modules/braces" }]);
    expect(proof.runtimePaths).toEqual(["node_modules/runtime"]);
  });
  it.each([
    ["removed patch guard", async () => rm(path.join(root, "node_modules/braces/lib/nesting-guard.js"))],
    ["changed installed source hash", async () => writeFile(path.join(root, "node_modules/braces/index.js"), "module.exports = {};\n")],
    ["changed patch hash", async () => writeFile(path.join(root, "vendor/braces-security.patch"), "changed\n")],
    ["tampered provenance plus matching source", async () => { await writeFile(path.join(root, "vendor/braces/index.js"), "changed\n"); await edit("vendor/braces-provenance.json", (p) => { p.patch.source_sha256["index.js"] = "changed"; }); }],
    ["changed installed package version", async () => edit("node_modules/braces/package.json", (p) => { p.version = "3.0.4"; })],
    ["changed lock identity", async () => edit("package-lock.json", (p) => { p.packages["node_modules/braces"].integrity = "changed"; })],
    ["removed root patch declaration", async () => edit("package.json", (p) => { delete p.devDependencies.braces; })],
    ["changed candidate archive", async () => writeFile(path.join(root, "vendor/braces-3.0.3-local.tgz"), "changed")],
    ["additional executable hidden in internal node_modules", async () => { const p = path.join(root, "node_modules/braces/lib/node_modules"); await mkdir(p, { recursive: true }); await writeFile(path.join(p, "hidden.js"), "module.exports = {};\n"); }],
    ["additional executable file", async () => writeFile(path.join(root, "node_modules/braces/backdoor.js"), "module.exports = {};\n")],
    ["additional unpatched copy", async () => cp(path.join(root, "vendor/braces"), path.join(root, "node_modules/consumer/node_modules/braces"), { recursive: true })],
    ["unmanifested deep directory shadow", async () => { const p = path.join(root, "node_modules/consumer/lib/node_modules/braces"); await mkdir(p, { recursive: true }); await writeFile(path.join(p, "index.js"), "module.exports = {};\n"); }],
    ["empty deep directory shadow", async () => mkdir(path.join(root, "node_modules/consumer/lib/node_modules/braces"), { recursive: true })],
    ["symlink package", async () => { await rm(path.join(root, "node_modules/braces"), { recursive: true }); await symlink(path.join(root, "vendor/braces"), path.join(root, "node_modules/braces")); }],
    ["symlink hidden behind arbitrary .bin", async () => { const p = path.join(root, "node_modules/consumer/lib/.bin"); await mkdir(p, { recursive: true }); await symlink(path.join(root, "vendor/braces"), path.join(p, "hidden")); }],
    ["escaping canonical bin link", async () => { await mkdir(path.join(root, "node_modules/.bin")); await symlink(path.join(repo, "package.json"), path.join(root, "node_modules/.bin/escape")); }],
    ["undeclared canonical bin link", async () => { await mkdir(path.join(root, "node_modules/.bin")); await symlink("../consumer/index.js", path.join(root, "node_modules/.bin/hidden")); }],
  ])("fails closed for %s", async (_label, change) => { await change(); await expect(inspectInstalledBraces(root)).rejects.toThrow(); });
  it.each(["braces", "braces.js", "braces.json", "braces.node"])("rejects Node file-resolution shadow %s", async (filename) => {
    const p = path.join(root, "node_modules/consumer/lib/node_modules"); await mkdir(p, { recursive: true }); await writeFile(path.join(p, filename), "{}\n");
    await expect(inspectInstalledBraces(root)).rejects.toThrow(/file shadow/);
  });
  it("does not equate dev:true with absence from runtime dependency chains", async () => {
    await edit("node_modules/runtime/package.json", (p) => { p.dependencies = { consumer: "1.0.0" }; });
    await edit("package-lock.json", (p) => { p.packages["node_modules/runtime"].dependencies = { consumer: "1.0.0" }; });
    await expect(inspectInstalledBraces(root)).rejects.toThrow(/production dependency chain/);
  });
  it("retains installed npm dependencies that collide with Node core names", async () => {
    // uri-js@4.4.1 declares punycode^2.1.0; Node22 resolves the bare name to
    // core and returns null lookup paths, while npm installs punycode@2.3.1.
    await addPackage("uri-js", { name: "uri-js", version: "4.4.1", dependencies: { punycode: "^2.1.0" } });
    await addPackage("punycode", { name: "punycode", version: "2.3.1" });
    await edit("node_modules/runtime/package.json", (p) => { p.dependencies = { "uri-js": "4.4.1" }; });
    await edit("package-lock.json", (p) => {
      p.packages["node_modules/runtime"].dependencies = { "uri-js": "4.4.1" };
      p.packages["node_modules/uri-js"] = { version: "4.4.1", dependencies: { punycode: "^2.1.0" } };
      p.packages["node_modules/punycode"] = { version: "2.3.1" };
    });
    const proof = await inspectInstalledBraces(root);
    expect(proof.edges["node_modules/uri-js"]).toEqual([{ name: "punycode", path: "node_modules/punycode", bareCoreSpecifier: "punycode" }]);
    expect(proof.runtimePaths).toContain("node_modules/punycode");
    // The external package remains in the runtime closure; it cannot conceal
    // braces behind the fact that a bare specifier may select a core module.
    await edit("node_modules/punycode/package.json", (p) => { p.dependencies = { braces: "^3.0.3" }; });
    await edit("package-lock.json", (p) => { p.packages["node_modules/punycode"].dependencies = { braces: "^3.0.3" }; });
    await expect(inspectInstalledBraces(root)).rejects.toThrow(/production dependency chain includes braces/);
    await rm(path.join(root, "node_modules/punycode"), { recursive: true });
    await expect(inspectInstalledBraces(root)).rejects.toThrow(/required installed package missing/);
  });
  it.each(["punycode", "arbitrary-missing-package"])("never skips a missing declared dependency: %s", async (name) => {
    await edit("node_modules/runtime/package.json", (p) => { p.dependencies = { [name]: "^2.1.0" }; });
    await edit("package-lock.json", (p) => { p.packages["node_modules/runtime"].dependencies = { [name]: "^2.1.0" }; });
    await expect(inspectInstalledBraces(root)).rejects.toThrow(/required dependency unresolved/);
  });
  it("allows only declared canonical in-root binary links to real files", async () => {
    await edit("node_modules/consumer/package.json", (p) => { p.bin = { consumer: "index.js" }; });
    await mkdir(path.join(root, "node_modules/.bin")); await symlink("../consumer/index.js", path.join(root, "node_modules/.bin/consumer"));
    await expect(inspectInstalledBraces(root)).resolves.toHaveProperty("bracesPaths");
  });
});

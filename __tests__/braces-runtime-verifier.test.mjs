import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
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


const PG_ALIAS = ".next/node_modules/pg-587764f78a6c7a9c";
const PGLITE_ALIAS = ".next/node_modules/@electric-sql/pglite-7966c14983af6418";
async function addNextAlias(name = "pg", alias = PG_ALIAS) {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  manifest.dependencies = { ...manifest.dependencies, [name]: "1.0.0" };
  await json("package.json", manifest);
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  lock.lockfileVersion = 3;
  lock.packages = { ...lock.packages, "": manifest, [`node_modules/${name}`]: { version: "1.0.0" } };
  await json("package-lock.json", lock);
  for (const base of ["", ".next/standalone/"]) {
    await json(`${base}node_modules/${name}/package.json`, { name, version: "1.0.0" });
    await put(`${base}node_modules/${name}/index.js`, "module.exports = {};\n");
    const full = path.join(root, base, alias);
    await mkdir(path.dirname(full), { recursive: true });
    await symlink(path.relative(path.dirname(full), path.join(root, base, "node_modules", name)), full);
  }
  const trace = JSON.parse(await readFile(path.join(root, ".next/server/chunk.js.nft.json"), "utf8"));
  trace.files.push(path.relative(path.join(root, ".next/server"), path.join(root, alias)));
  await json(".next/server/chunk.js.nft.json", trace);
}
async function replaceLink(file, target) { await rm(path.join(root, file)); await symlink(target, path.join(root, file)); }

describe("narrow generated Next runtime module aliases", () => {
  it("accepts real pg and scoped pglite alias shapes with full physical target and NFT evidence", async () => {
    await addNextAlias(); await addNextAlias("@electric-sql/pglite", PGLITE_ALIAS);
    const proof = await verifyRuntimeArtifacts(root);
    expect(proof.runtimeModuleAliases.map((alias) => alias.package).sort()).toEqual(["@electric-sql/pglite", "pg"]);
    expect(proof.runtimeModuleAliases.find((alias) => alias.package === "pg")).toMatchObject({
      alias: PG_ALIAS, link: "../../node_modules/pg", target: "node_modules/pg", version: "1.0.0",
    });
    expect(proof.files[".next/standalone/node_modules/pg/index.js"]).toBe(sha256("module.exports = {};\n"));
    expect(proof.files[".next/standalone/node_modules/@electric-sql/pglite/package.json"]).toBeDefined();
  });
  it.each([
    ["outside shipped artifact but inside project", async () => replaceLink(`.next/standalone/${PG_ALIAS}`, "../../../../node_modules/pg")],
    ["absolute destination", async () => replaceLink(`.next/standalone/${PG_ALIAS}`, path.join(root, ".next/standalone/node_modules/pg"))],
    ["broken link", async () => rm(path.join(root, ".next/standalone/node_modules/pg"), { recursive: true })],
    ["self-cycle", async () => replaceLink(`.next/standalone/${PG_ALIAS}`, "pg-587764f78a6c7a9c")],
    ["target alias chain", async () => { await rm(path.join(root, ".next/standalone/node_modules/pg"), { recursive: true }); await symlink("../.next/node_modules/pg-587764f78a6c7a9c", path.join(root, ".next/standalone/node_modules/pg")); }],
    ["target parent symlink", async () => { await rm(path.join(root, ".next/standalone/node_modules"), { recursive: true }); await symlink(path.join(root, "node_modules"), path.join(root, ".next/standalone/node_modules")); }],
    ["alias to braces", async () => replaceLink(`.next/standalone/${PG_ALIAS}`, "../../node_modules/braces")],
    ["renamed braces identity", async () => json(".next/standalone/node_modules/pg/package.json", { name: "braces", version: "1.0.0" })],
    ["nested braces package", async () => json(".next/standalone/node_modules/pg/node_modules/braces/package.json", { name: "braces", version: "3.0.3" })],
    ["nested braces file shadow", async () => put(".next/standalone/node_modules/pg/lib/node_modules/braces.js", "module.exports = {};\n")],
    ["renamed nested braces package", async () => json(".next/standalone/node_modules/pg/lib/other/package.json", { name: "braces", version: "3.0.3" })],
    ["embedded braces code inside valid target", async () => put(".next/standalone/node_modules/pg/lib/hidden.js", "require('braces')")],
    ["missing target code inventory", async () => rm(path.join(root, ".next/standalone/node_modules/pg/index.js"))],
    ["unknown package alias", async () => { const full = path.join(root, ".next/standalone/.next/node_modules/other-587764f78a6c7a9c"); await symlink("../../node_modules/pg", full); }],
    ["duplicate ambiguous package alias", async () => { const full = path.join(root, ".next/standalone/.next/node_modules/pg-1111111111111111"); await symlink("../../node_modules/pg", full); }],
    ["unreferenced extra build alias", async () => symlink("../../node_modules/pg", path.join(root, ".next/node_modules/pg-1111111111111111"))],
    ["unreferenced shipped alias", async () => json(".next/server/chunk.js.nft.json", { version: 1, files: ["chunk.js"] })],
    ["missing shipped alias for traced input", async () => rm(path.join(root, ".next/standalone", PG_ALIAS))],
    ["changed build target manifest", async () => json("node_modules/pg/package.json", { name: "pg", version: "1.0.0", changed: true })],
    ["different lock version", async () => { const l = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")); l.packages["node_modules/pg"].version = "2.0.0"; await json("package-lock.json", l); }, /runtime alias package\/lock identity mismatch/],
    ["development-only lock target", async () => { const l = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")); l.packages["node_modules/pg"].dev = true; await json("package-lock.json", l); }, /runtime alias package\/lock identity mismatch/],
    ["source alias escape", async () => replaceLink(PG_ALIAS, "/tmp/nonexistent-runtime-alias-target")],
  ])("rejects %s without skipping runtime proof", async (_label, change, expected) => {
    await addNextAlias(); await change(); await expect(verifyRuntimeArtifacts(root)).rejects.toThrow(expected);
  });
  it.each([
    ["empty production declaration", async () => { const m = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); m.dependencies.pg = ""; await json("package.json", m); }],
    ["missing target versions", async () => { for (const base of ["", ".next/standalone/"]) await json(`${base}node_modules/pg/package.json`, { name: "pg" }); const l = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")); delete l.packages["node_modules/pg"].version; await json("package-lock.json", l); }],
    ["matching numeric versions", async () => { for (const base of ["", ".next/standalone/"]) await json(`${base}node_modules/pg/package.json`, { name: "pg", version: 1 }); const l = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")); l.packages["node_modules/pg"].version = 1; await json("package-lock.json", l); }],
    ["malformed dev flag", async () => { const l = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")); l.packages["node_modules/pg"].dev = "true"; await json("package-lock.json", l); }],
    ["malformed link flag", async () => { const l = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")); l.packages["node_modules/pg"].link = null; await json("package-lock.json", l); }],
    ["missing root lock declaration", async () => { const l = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")); delete l.packages[""].dependencies.pg; await json("package-lock.json", l); }],
  ])("rejects malformed alias identity: %s", async (_label, change) => { await addNextAlias(); await change(); await expect(verifyRuntimeArtifacts(root)).rejects.toThrow(); });
  it.each([".next/static", ".preflight"])("does not permit aliases in %s", async (artifact) => {
    await addNextAlias();
    const full = path.join(root, artifact, PG_ALIAS);
    await mkdir(path.dirname(full), { recursive: true }); await symlink(path.join(root, "node_modules/pg"), full);
    await expect(verifyRuntimeArtifacts(root)).rejects.toThrow(/symlink outside standalone/);
  });
});

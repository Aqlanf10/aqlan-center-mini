import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { verifyRuntimeArtifacts, validateRuntimeSourceMap } from "../scripts/verify-braces-runtime.mjs";
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


const emptyNextMap = { version: 3, sources: [], sections: [] };
async function addEmptyNextEntry() {
  const entry = ".next/server/app/page.js";
  for (const prefix of ["", ".next/standalone/"]) {
    await put(`${prefix}${entry}`, "console.log('entry');\n");
    await json(`${prefix}${entry}.map`, emptyNextMap);
  }
  await json(`${entry}.nft.json`, { version: 1, files: ["page.js"] });
  return entry;
}
describe("standards-valid zero-attribution Next indexed source maps", () => {
  it("accepts the witnessed empty map with zero source attribution", () => {
    expect(validateRuntimeSourceMap(emptyNextMap, "page.js.map")).toEqual({ sourceInputCount: 0, emptyIndexedMapCount: 1 });
    expect(validateRuntimeSourceMap({ version: 3, sections: [] }, "page.js.map")).toEqual({ sourceInputCount: 0, emptyIndexedMapCount: 1 });
  });
  it("records empty map evidence separately and binds exact generated/map bytes plus validated NFT", async () => {
    await addEmptyNextEntry();
    const proof = await verifyRuntimeArtifacts(root);
    expect(proof.sourceMapCount).toBe(2);
    expect(proof.sourceMapInputCount).toBe(1); // Only the existing nonempty basic map contributes.
    expect(proof.emptyIndexedMapCount).toBe(1);
    expect(proof.emptyIndexedMaps).toEqual([expect.objectContaining({
      map: ".next/standalone/.next/server/app/page.js.map", nft: ".next/server/app/page.js.nft.json", sourceInputCount: 0,
      generatedSha256: sha256("console.log('entry');\n"), mapSha256: sha256(JSON.stringify(emptyNextMap)),
    })]);
  });
  it("does not manufacture attribution when all existing maps are empty", async () => {
    await rm(path.join(root, ".next/standalone/chunk.js.map")); await addEmptyNextEntry();
    const proof = await verifyRuntimeArtifacts(root);
    expect(proof.sourceMapCount).toBe(1); expect(proof.sourceMapInputCount).toBe(0); expect(proof.emptyIndexedMapCount).toBe(1);
  });
  it.each([
    ["missing shipped JavaScript", async (e) => rm(path.join(root, ".next/standalone", e))],
    ["missing build map", async (e) => rm(path.join(root, `${e}.map`))],
    ["different generated bytes", async (e) => put(e, "different")],
    ["different map bytes", async (e) => json(`${e}.map`, { version: 3, sections: [] })],
    ["missing NFT", async (e) => rm(path.join(root, `${e}.nft.json`))],
    ["malformed NFT", async (e) => json(`${e}.nft.json`, { version: 1, files: [] })],
    ["hidden braces in sibling JavaScript", async (e) => { await put(e, "require('braces')"); await put(`.next/standalone/${e}`, "require('braces')"); }],
    ["unbound map outside Next entry", async () => json(".next/standalone/chunk.js.map", emptyNextMap)],
  ])("still rejects %s", async (_label, change) => { const entry = await addEmptyNextEntry(); await change(entry); await expect(verifyRuntimeArtifacts(root)).rejects.toThrow(); });
  it.each([
    ["nonarray sections", { ...emptyNextMap, sections: "invalid" }],
    ["null sections", { ...emptyNextMap, sections: null }],
    ["explicit undefined sections", { ...emptyNextMap, sections: undefined }],
    ["malformed sources", { ...emptyNextMap, sources: null }],
    ["dot-segment flat source", { version: 3, sourceRoot: "node_modules", sources: ["ignored/../braces/index.js"], mappings: "" }],
    ["dot-segment URL source", { version: 3, sources: ["webpack:///node_modules/ignored/../braces/index.js"], mappings: "" }],
    ["file-shadow source query", { version: 3, sources: ["webpack:///node_modules/braces.js?commonjs-proxy"], mappings: "" }],
    ["file-shadow source fragment", { version: 3, sources: ["node_modules/braces.node#fragment"], mappings: "" }],
    ["encoded URL package", { version: 3, sources: ["webpack:///node_modules/%62races/index.js"], mappings: "" }],
    ["encoded dot segments", { version: 3, sources: ["webpack:///node_modules/ignored/%2e%2e/braces/index.js"], mappings: "" }],
    ["backslash source path", { version: 3, sources: ["node_modules\\ignored\\..\\braces\\index.js"], mappings: "" }],
    ["dot-segment indexed parent", { ...emptyNextMap, sourceRoot: "node_modules", sources: ["ignored/../braces/index.js"] }],
    ["dot-segment nested input", { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sourceRoot: "node_modules", sources: ["ignored/../braces/index.js"], mappings: "" } }] }],
    ["hidden parent braces source", { ...emptyNextMap, sources: ["node_modules/braces/index.js"] }],
    ["ambiguous parent sources", { ...emptyNextMap, sources: ["app/hidden.js"] }],
    ["hidden parent sourceRoot", { ...emptyNextMap, sourceRoot: "node_modules/braces" }],
    ["malformed sourceRoot", { ...emptyNextMap, sourceRoot: 9 }],
    ["malformed file", { ...emptyNextMap, file: {} }],
    ["hidden parent source content", { ...emptyNextMap, sources: ["hidden.js"], sourcesContent: ["require('braces')"] }],
    ["malformed source content", { ...emptyNextMap, sourcesContent: "invalid" }],
    ["malformed mappings", { ...emptyNextMap, mappings: 1 }],
    ["ambiguous indexed mappings", { ...emptyNextMap, mappings: "AAAA" }],
    ["external section", { version: 3, sections: [{ offset: { line: 0, column: 0 }, url: "https://example.invalid/map" }] }],
    ["external section with embedded map", { version: 3, sections: [{ offset: { line: 0, column: 0 }, url: "https://example.invalid/map", map: emptyNextMap }] }],
    ["missing section offset", { version: 3, sections: [{ map: emptyNextMap }] }],
    ["negative section offset", { version: 3, sections: [{ offset: { line: -1, column: 0 }, map: emptyNextMap }] }],
    ["nonnumeric section offset", { version: 3, sections: [{ offset: { line: "0", column: 0 }, map: emptyNextMap }] }],
    ["hidden nested braces source", { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ["node_modules/braces/index.js"], mappings: "" } }] }],
    ["malformed nested sections", { version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: [], mappings: "", sections: null } }] }],
    ["missing basic mappings", { version: 3, sources: [] }],
    ["unordered section offsets", { version: 3, sections: [{ offset: { line: 2, column: 0 }, map: emptyNextMap }, { offset: { line: 1, column: 0 }, map: emptyNextMap }] }],
  ])("fails closed on %s", (_label, map) => { expect(() => validateRuntimeSourceMap(map, "synthetic.map")).toThrow(); });
  it("continues to inspect nonempty nested section input/content with accurate attribution", () => {
    const map = { version: 3, sources: [], sections: [{ offset: { line: 0, column: 0 }, map: emptyNextMap }, { offset: { line: 1, column: 0 }, map: { version: 3, sources: ["app/page.tsx"], sourcesContent: ["export const safe = true;"], mappings: "" } }] };
    expect(validateRuntimeSourceMap(map, "synthetic.map")).toEqual({ sourceInputCount: 1, emptyIndexedMapCount: 1 });
  });
});

import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assembleStandaloneEntryChunks, entryChunks } from "./assemble-standalone-entry-chunks.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-entry-assembly-"));
  const put = async (name, content) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
  const build = ".next/server", shipped = ".next/standalone/.next/server";
  const entry = 'var R=require("../../chunks/[turbopack]_runtime.js")("server/app/_global-error/page.js")\nR.c("server/chunks/ssr/synthetic.js")\nR.m(42)\n';
  try {
    await put(".next/BUILD_ID", "synthetic-build-id\n");
    await put(".next/standalone/.next/BUILD_ID", "synthetic-build-id\n");
    await put(`${build}/app/_global-error/page.js`, entry);
    await put(`${shipped}/app/_global-error/page.js`, entry);
    await put(`${build}/chunks/ssr/synthetic.js`, "synthetic chunk bytes\n");
    await put(`${build}/chunks/ssr/synthetic.js.map`, '{"version":3,"sources":[],"mappings":""}');
    await put(`${build}/chunks/[turbopack]_runtime.js`, "synthetic runtime\n");
    await put(`${shipped}/chunks/[turbopack]_runtime.js`, "synthetic runtime\n");
    await run({ root, put, build, shipped, entry });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("copies a referenced build chunk without its source map, then is idempotent", () => fixture(async ({root, build, shipped}) => {
  const result = await assembleStandaloneEntryChunks(root);
  assert.deepEqual(result.copied, ["server/chunks/ssr/synthetic.js"]);
  assert.deepEqual(await readFile(path.join(root, shipped, "chunks/ssr/synthetic.js")), await readFile(path.join(root, build, "chunks/ssr/synthetic.js")));
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js.map")), { code: "ENOENT" });
  assert.deepEqual((await assembleStandaloneEntryChunks(root)).copied, []);
}));
async function addNft({put, build, shipped}, files = ["../../chunks/ssr/nft-only.js"]) {
  const contents = JSON.stringify({version: 1, files});
  await put(`${build}/app/_global-error/page.js.nft.json`, contents);
  await put(`${shipped}/app/_global-error/page.js.nft.json`, contents);
}
test("copies an NFT-only compiled SSR chunk from the matching build without its map", () => fixture(async f => {
  const {root, put, build, shipped} = f;
  await addNft(f);
  await put(`${build}/chunks/ssr/nft-only.js`, "module.exports = 'synthetic traced chunk';\n");
  await put(`${build}/chunks/ssr/nft-only.js.map`, JSON.stringify({version:3,sources:["synthetic.ts"],sourcesContent:["SYNTHETIC_PRIVATE_SOURCE"],mappings:""}));
  const tracePath = path.join(root, shipped, "app/_global-error/page.js.nft.json");
  const traceInput = path.resolve(path.dirname(tracePath), "../../chunks/ssr/nft-only.js");
  // Match lint-runtime's actual failure mode: realpath on a shipped NFT input.
  await assert.rejects(realpath(traceInput), {code:"ENOENT"});
  const result = await assembleStandaloneEntryChunks(root);
  assert.deepEqual(result.copied, ["server/chunks/ssr/nft-only.js", "server/chunks/ssr/synthetic.js"]);
  assert.deepEqual(await readFile(path.join(root, shipped, "chunks/ssr/nft-only.js")), await readFile(path.join(root, build, "chunks/ssr/nft-only.js")));
  assert.equal(await realpath(traceInput), traceInput);
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/nft-only.js.map")), {code:"ENOENT"});
  assert.deepEqual((await assembleStandaloneEntryChunks(root)).copied, []);
}));
test("refuses an NFT input that is absolute, ambiguous or escapes the project before any copy", () => fixture(async f => {
  const {root, put, build, shipped} = f;
  for (const input of ["/tmp/escape.js", "C:/outside.js", "..\\escape.js", "bad\0input", "../../../../../../../../outside.js"]) {
    await addNft(f, [input]);
    await assert.rejects(assembleStandaloneEntryChunks(root), /STANDALONE_ENTRY_REJECTED/);
    await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js")), {code:"ENOENT"});
  }
  await put(`${build}/app/_global-error/page.js.nft.json`, "bad json");
  await put(`${shipped}/app/_global-error/page.js.nft.json`, "bad json");
  await assert.rejects(assembleStandaloneEntryChunks(root), /invalid standalone trace/);
}));
test("refuses a forged NFT, altered trace entry, or mismatched build identity", () => fixture(async f => {
  const {root, put, build, shipped} = f;
  await addNft(f);
  await put(`${shipped}/app/_global-error/page.js.nft.json`, JSON.stringify({version:1,files:["../../chunks/ssr/forged.js"]}));
  await assert.rejects(assembleStandaloneEntryChunks(root), /standalone trace differs from build/);
  await addNft(f);
  await put(`${shipped}/app/_global-error/page.js`, "// altered entry\n");
  await assert.rejects(assembleStandaloneEntryChunks(root));
  await put(`${shipped}/app/_global-error/page.js`, f.entry);
  await put(".next/standalone/.next/BUILD_ID", "different-build\n");
  await assert.rejects(assembleStandaloneEntryChunks(root), /build identity mismatch/);
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js")), {code:"ENOENT"});
}));
test("refuses missing, linked, or inline-mapped NFT chunk without partial writes", () => fixture(async f => {
  const {root, put, build, shipped} = f;
  await addNft(f);
  await assert.rejects(assembleStandaloneEntryChunks(root));
  await put(`${build}/chunks/ssr/nft-only.js`, "module.exports = 1;\n//# sourceMappingURL=data:application/json;base64,e30=\n");
  await assert.rejects(assembleStandaloneEntryChunks(root), /inline source map/);
  const chunk = path.join(root, build, "chunks/ssr/nft-only.js");
  await rm(chunk); await symlink("synthetic.js", chunk);
  await assert.rejects(assembleStandaloneEntryChunks(root), /non-regular path/);
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js")), {code:"ENOENT"});
}));
test("copies only bootstrap-referenced compiled assets, never unrelated application source", () => fixture(async ({root, put, shipped}) => {
  await put("lib/synthetic-private-source.ts", "synthetic source file\n");
  await put(".next/server/chunks/ssr/unreferenced.js", "unreferenced generated chunk\n");
  await put(".next/server/chunks/ssr/synthetic.js.map", JSON.stringify({version: 3, sources: ["synthetic.ts"], sourcesContent: ["synthetic private source"], mappings: ""}));
  const result = await assembleStandaloneEntryChunks(root);
  assert.deepEqual(result.copied, ["server/chunks/ssr/synthetic.js"]);
  await assert.rejects(readFile(path.join(root, ".next/standalone/lib/synthetic-private-source.ts")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js.map")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/unreferenced.js")), { code: "ENOENT" });
}));
test("inspects omitted source maps with both original dependency guards before copying", () => fixture(async ({root, put, build, shipped}) => {
  const maps = [
    {version: 3, sources: ["node_modules/braces/index.js"], mappings: ""},
    {version: 3, sources: ["safe.js"], sourcesContent: ["require('braces')"], mappings: ""},
    {version: 3, sources: ["node_modules/%65slint/index.js"], mappings: ""},
    {version: 3, sections: [{offset: {line: 0, column: 0}, map: {version: 3, sources: ["node_modules/minimatch/index.js"], mappings: ""}}]},
  ];
  for (const map of maps) {
    await put(`${build}/chunks/ssr/synthetic.js.map`, JSON.stringify(map));
    await assert.rejects(assembleStandaloneEntryChunks(root), /build source map failed dependency validation/);
    await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js.map")), { code: "ENOENT" });
  }
}));
test("rejects an inline source map before adding the compiled chunk", () => fixture(async ({root, put, build, shipped}) => {
  await put(`${build}/chunks/ssr/synthetic.js`, "module.exports = 1;\n//# sourceMappingURL=data:application/json;base64,e30=\n");
  await assert.rejects(assembleStandaloneEntryChunks(root), /inline source map in entry chunk/);
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js")), { code: "ENOENT" });
}));
test("runs an assembled synthetic entry without shipping its external map", () => fixture(async ({root, put, build, shipped}) => {
  const runtime = 'const path = require("node:path"); module.exports = () => ({c(name) { require(path.join(__dirname, "../..", name)); }, m() {}});';
  const chunk = 'global.syntheticEntryRan = true;\n//# sourceMappingURL=synthetic.js.map\n';
  await put(`${build}/chunks/[turbopack]_runtime.js`, runtime);
  await put(`${shipped}/chunks/[turbopack]_runtime.js`, runtime);
  await put(`${build}/chunks/ssr/synthetic.js`, chunk);
  await assembleStandaloneEntryChunks(root);
  const entry = path.join(root, shipped, "app/_global-error/page.js");
  const child = spawnSync(process.execPath, ["--enable-source-maps", "-e", 'require(process.argv[1]); if (!global.syntheticEntryRan) process.exit(1);', entry], {encoding: "utf8"});
  assert.equal(child.status, 0, child.stderr);
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js.map")), { code: "ENOENT" });
}));
test("fails closed on unknown, computed or traversing bootstrap references", () => {
  for (const source of ['R.c(name)', 'R.c("server/chunks/../../outside.js")', 'R.c("/tmp/outside.js")', 'R . c ("server/chunks/a.js")', 'R.c("server/chunks/good.js")\nX.c("server/chunks/missing.js")']) assert.throws(() => entryChunks(source), /STANDALONE_ENTRY_REJECTED/);
});
test("rejects missing original chunk without writing anything", () => fixture(async ({root, build, shipped}) => {
  await rm(path.join(root, build, "chunks/ssr/synthetic.js"));
  await assert.rejects(assembleStandaloneEntryChunks(root));
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js")), { code: "ENOENT" });
}));
test("rejects altered shipped entries and altered existing chunks", () => fixture(async ({root, put, shipped}) => {
  await put(`${shipped}/app/_global-error/page.js`, 'var R=require("../../chunks/[turbopack]_runtime.js")("server/app/_global-error/page.js")\nR.c("server/chunks/ssr/synthetic.js")\n// altered\n');
  await assert.rejects(assembleStandaloneEntryChunks(root), /entry differs from build/);
}));
test("rejects a missing or changed bootstrap syntax and a forged entry identity", () => fixture(async ({root, put, build, shipped, entry}) => {
  for (const [text, reason] of [['R.c("server/chunks/ssr/synthetic.js")\n', /unrecognized entry bootstrap/], [entry.replace("server/app/_global-error/page.js", "server/app/other/page.js"), /unrecognized entry bootstrap/], [entry.replace('R.c(', 'X.c('), /unrecognized entry chunk syntax/]]) {
    await put(`${build}/app/_global-error/page.js`, text); await put(`${shipped}/app/_global-error/page.js`, text);
    await assert.rejects(assembleStandaloneEntryChunks(root), reason);
  }
}));
test("rejects an existing chunk with bytes different from its build original", () => fixture(async ({root, put, shipped}) => {
  await put(`${shipped}/chunks/ssr/synthetic.js`, "different synthetic chunk\n");
  await assert.rejects(assembleStandaloneEntryChunks(root), /shipped chunk differs from build/);
}));
test("rejects a symlinked build map and a conflicting existing shipped map", () => fixture(async ({root, put, build, shipped}) => {
  const map = path.join(root, build, "chunks/ssr/synthetic.js.map");
  await rm(map); await symlink("synthetic.js", map);
  await assert.rejects(assembleStandaloneEntryChunks(root), /non-regular path/);
  await rm(map); await writeFile(map, '{"version":3,"sources":[],"mappings":""}');
  await put(`${shipped}/chunks/ssr/synthetic.js.map`, '{"version":3,"sources":["different"],"mappings":""}');
  await assert.rejects(assembleStandaloneEntryChunks(root), /shipped map differs from build/);
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js")), {code:"ENOENT"});
}));
test("rejects a conflicting map even when its chunk already exists", () => fixture(async ({root, put, shipped}) => {
  await put(`${shipped}/chunks/ssr/synthetic.js`, "synthetic chunk bytes\n");
  await put(`${shipped}/chunks/ssr/synthetic.js.map`, '{"version":3,"sources":["different"],"mappings":""}');
  await assert.rejects(assembleStandaloneEntryChunks(root), /shipped map differs from build/);
}));
test("rejects symlinked source files and destination files", () => fixture(async ({root, build, shipped}) => {
  const source = path.join(root, build, "chunks/ssr/synthetic.js");
  await rm(source); await symlink("synthetic.js.map", source);
  await assert.rejects(assembleStandaloneEntryChunks(root), /non-regular path/);
  await rm(source); await writeFile(source, "synthetic chunk bytes\n");
  const target = path.join(root, shipped, "chunks/ssr/synthetic.js"); await mkdir(path.dirname(target), {recursive:true});
  await symlink("../../../../../../server/chunks/ssr/synthetic.js", target);
  await assert.rejects(assembleStandaloneEntryChunks(root), /non-regular path/);
}));
test("rejects symlinked source and destination ancestor directories", () => fixture(async ({root, build, shipped}) => {
  const dir = path.join(root, build, "chunks/ssr"); await rm(dir, { recursive: true }); await symlink(".", dir);
  await assert.rejects(assembleStandaloneEntryChunks(root), /non-regular path/);
  await rm(dir); await mkdir(dir); await writeFile(path.join(dir, "synthetic.js"), "synthetic chunk bytes\n");
  const dest = path.join(root, shipped, "chunks"); await rm(dest, {recursive:true}); await symlink(".", dest);
  await assert.rejects(assembleStandaloneEntryChunks(root), /non-regular path/);
}));
test("does not partially copy a planned chunk when a later reference is invalid", () => fixture(async ({root, put, build, shipped, entry}) => {
  const changed = `${entry}R.c("server/chunks/ssr/z-missing.js")\n`;
  await put(`${build}/app/_global-error/page.js`, changed); await put(`${shipped}/app/_global-error/page.js`, changed);
  await assert.rejects(assembleStandaloneEntryChunks(root));
  await assert.rejects(readFile(path.join(root, shipped, "chunks/ssr/synthetic.js")), {code:"ENOENT"});
}));

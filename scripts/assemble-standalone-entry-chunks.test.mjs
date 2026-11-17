import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assembleStandaloneEntryChunks, entryChunks } from "./assemble-standalone-entry-chunks.mjs";

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-entry-assembly-"));
  const put = async (name, content) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
  const build = ".next/server", shipped = ".next/standalone/.next/server";
  const entry = 'var R=require("../../chunks/[turbopack]_runtime.js")("server/app/_global-error/page.js")\nR.c("server/chunks/ssr/synthetic.js")\nR.m(42)\n';
  try {
    await put(`${build}/app/_global-error/page.js`, entry);
    await put(`${shipped}/app/_global-error/page.js`, entry);
    await put(`${build}/chunks/ssr/synthetic.js`, "synthetic chunk bytes\n");
    await put(`${build}/chunks/ssr/synthetic.js.map`, '{"version":3,"sources":[],"mappings":""}');
    await put(`${build}/chunks/[turbopack]_runtime.js`, "synthetic runtime\n");
    await put(`${shipped}/chunks/[turbopack]_runtime.js`, "synthetic runtime\n");
    await run({ root, put, build, shipped, entry });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("copies a referenced build chunk and its map exactly, then is idempotent", () => fixture(async ({root, build, shipped}) => {
  const result = await assembleStandaloneEntryChunks(root);
  assert.deepEqual(result.copied, ["server/chunks/ssr/synthetic.js", "server/chunks/ssr/synthetic.js.map"]);
  for (const name of ["synthetic.js", "synthetic.js.map"]) assert.deepEqual(await readFile(path.join(root, shipped, "chunks/ssr", name)), await readFile(path.join(root, build, "chunks/ssr", name)));
  assert.deepEqual((await assembleStandaloneEntryChunks(root)).copied, []);
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

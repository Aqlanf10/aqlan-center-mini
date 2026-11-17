import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function localNextSwc() {
  const triples = require("next/dist/compiled/@napi-rs/triples").platformArchTriples;
  const next = require("next/package.json"), expected = next.version;
  for (const triple of triples[process.platform]?.[process.arch] ?? []) {
    try {
      const name = `@next/swc-${triple.platformArchABI}`;
      if (next.optionalDependencies?.[name] !== expected || require(`${name}/package.json`).version !== expected) continue;
      const binding = require(name);
      if (typeof binding.transformSync === "function") return binding;
    } catch { /* Never download or modify dependencies to find a binding. */ }
  }
  throw new Error("No matching locally installed Next SWC native binding");
}

describe("backup dynamic path tracing comments", () => {
  it.each([
    ["lib/backupVolume.ts", "path.resolve(/*turbopackIgnore: true*/ backupDir, backupId)", "path.resolve(backupDir, backupId)"],
    ["lib/productionBackup.ts", "path.resolve(/*turbopackIgnore: true*/ documentsRoot, storageKey)", "path.resolve(documentsRoot, storageKey)"],
  ])("preserves emitted JavaScript with comments removed in %s", (file, annotated, original) => {
    const source = readFileSync(file, "utf8");
    expect(source.split(annotated)).toHaveLength(2);
    const prior = source.replace(annotated, original);
    const tsOptions = { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: false, removeComments: true }, reportDiagnostics: true };
    const oldTs = ts.transpileModule(prior, tsOptions), newTs = ts.transpileModule(source, tsOptions);
    expect(oldTs.diagnostics ?? []).toEqual([]); expect(newTs.diagnostics ?? []).toEqual([]);
    expect(newTs.outputText).toBe(oldTs.outputText);
    const options = Buffer.from(JSON.stringify({ filename: file, jsc: { parser: { syntax: "typescript" }, target: "es2022", minify: { format: { comments: false } } }, module: { type: "es6" }, sourceMaps: false }));
    const swc = localNextSwc();
    expect(swc.transformSync(source, false, options).code).toBe(swc.transformSync(prior, false, options).code);
  });
});

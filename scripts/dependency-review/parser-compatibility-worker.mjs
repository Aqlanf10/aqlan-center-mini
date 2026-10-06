import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const [directoryArg, mode, outputArg] = process.argv.slice(2);
assert(["baseline", "candidate"].includes(mode) && directoryArg && outputArg);
const directory = realpathSync(directoryArg);
const output = resolve(outputArg);
const require = createRequire(join(directory, "package.json"));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const versions = mode === "baseline" ? { parser: "6.1.4", sourceMap: "1.2.1" } : { parser: "7.1.6", sourceMap: "1.2.2" };
const resolutions = [];
for (const [consumer, expected] of [["tailwindcss", "3.4.19"], ["postcss-nested", "6.2.0"]]) {
  const consumerFile = require.resolve(consumer + "/package.json");
  assert.equal(readJson(consumerFile).version, expected);
  const consumerRequire = createRequire(consumerFile);
  const parserFile = consumerRequire.resolve("postcss-selector-parser/package.json");
  assert.equal(readJson(parserFile).version, versions.parser);
  assert(realpathSync(parserFile).startsWith(directory + "/"));
  resolutions.push({ consumer, consumerVersion: expected, parserVersion: versions.parser, parserPath: relative(directory, parserFile) });
}
const postcss = require("postcss");
const tailwind = require("tailwindcss");
const nested = require("postcss-nested");
const parser = require("postcss-selector-parser");
const config = require("tailwindcss/loadConfig")(join(repo, "tailwind.config.ts"));
const rawClasses = "rtl:space-x-reverse md:grid-cols-2 focus:ring-2 hover:bg-accent-500 [&>svg]:size-4 [&:not(:first-child)]:mt-2 data-[state=open]:bg-navy-900 group-hover:text-danger-600 peer-checked:border-accent-500 before:content-['عربي'] bg-[rgb(1_2_3)] w-[calc(100%-1rem)] !text-sm -mt-2 print:hidden";
const globals = readFileSync(join(repo, "app/globals.css"), "utf8");
const boundedConfig = { ...config, content: [join(repo, "app/**/*.{ts,tsx}"), join(repo, "components/**/*.{ts,tsx}"), { raw: rawClasses, extension: "html" }] };
const appCss = (await postcss([tailwind(boundedConfig)]).process(globals, { from: join(repo, "app/globals.css"), map: false })).css;
writeFileSync(join(output, mode + "-app.css"), appCss);
const nestedInput = `.card, .panel {
  color: red;
  &:hover, &:focus-visible { color: blue; }
  & > svg:not([hidden]) { display: block; }
  .child & { margin: 0; }
  &[data-label="عربي"] { direction: rtl; }
  @media (min-width: 640px) { & + & { padding: 1px; } }
  @supports (display: grid) { & :is(.one, .two) { display: grid; } }
}
.escaped\\:class { & > .w-1\\/2, &:not(:first-child) { width: 50%; } }
`;
const nestedCss = (await postcss([nested()]).process(nestedInput, { from: undefined, map: false })).css;
writeFileSync(join(output, mode + "-nested.css"), nestedCss);
const selectors = new Set([
  ".a:hover > .b:not(:first-child)", "[data-label=\"عربي\"] .escaped\\:class",
  ":is(.one, .two) + :where(.three)", "svg|a[href]", ".w-1\\/2::before",
]);
postcss.parse(appCss + "\n" + nestedCss).walkRules(rule => selectors.add(rule.selector));
const roundTrips = [...selectors].map(selector => ({ selector, output: parser().processSync(selector) }));
// Exercise the mutation API used by nesting/selector transformers. Append while
// walking a snapshot so both v6 and v7 have intentional, bounded iteration.
const transformed = [...selectors].map(selector => ({ selector, output: parser(root => {
  root.walkClasses(node => { node.value = "review-" + node.value; });
  root.each(group => { const first = group.first; if (first) group.insertBefore(first, parser.className({ value: "scope" })); });
}).processSync(selector) }));
const postcssRequire = createRequire(require.resolve("postcss/package.json"));
const sourceMapFile = postcssRequire.resolve("source-map-js/package.json");
assert.equal(readJson(sourceMapFile).version, versions.sourceMap);
assert(realpathSync(sourceMapFile).startsWith(directory + "/"));
const { SourceMapGenerator, SourceMapConsumer, SourceNode } = postcssRequire("source-map-js");
const generator = new SourceMapGenerator({ file: "output.js" });
generator.addMapping({ generated: { line: 1, column: 0 }, original: { line: 1, column: 0 }, source: "input.js" });
generator.setSourceContent("input.js", "const a = 1;\n");
const sourceMap = generator.toJSON();
const roundTrip = SourceNode.fromStringWithSourceMap("const a = 1;\n", new SourceMapConsumer(sourceMap)).toStringWithSourceMap({ file: "output.js" });
const sourceMapBehavior = { code: roundTrip.code, map: roundTrip.map.toJSON(), original: new SourceMapConsumer(sourceMap).originalPositionFor({ line: 1, column: 0 }) };
if (mode === "candidate") {
  const indexed = line => ({ version: 3, sections: [{ offset: { line, column: 0 }, map: { version: 3, sources: ["a.js"], sourcesContent: ["a"], names: [], mappings: "AAAA" } }] });
  // Candidate-only bounded regression; never exercise a DoS payload on baseline.
  assert.throws(() => new SourceMapConsumer(indexed(10_000_001)), /must not exceed/);
  for (const value of [-1, 1.5, Infinity, "1", null]) assert.throws(() => new SourceMapConsumer(indexed(value)), /non-negative integers/);
  const node = SourceNode.fromStringWithSourceMap("var x;\n", new SourceMapConsumer(indexed(10_000_000)));
  assert.equal(node.toString(), "var x;\n"); assert(node.children.length < 10);
  const flat = ".a".repeat(20_000);
  assert.equal(parser().processSync(flat), flat);
}
const result = { mode, versions, resolutions, sourceMapPath: relative(directory, sourceMapFile),
  appCss: { bytes: Buffer.byteLength(appCss), sha256: sha256(appCss) },
  nestedCss: { bytes: Buffer.byteLength(nestedCss), sha256: sha256(nestedCss) },
  roundTrips, transformed, sourceMapBehavior,
  candidateSecurityRegressions: mode === "candidate" ? "passed" : "not run on vulnerable baseline" };
writeFileSync(join(output, mode + "-compatibility.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ mode, resolutions, appCss: result.appCss, nestedCss: result.nestedCss, selectors: selectors.size }));

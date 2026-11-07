import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

// Exercise Next's own matcher with collect-build-traces.js's route/file options.
const require = createRequire(import.meta.url);
const picomatch = require("next/dist/compiled/picomatch") as (
  patterns: string | string[], options: { dot: boolean; contains: boolean },
) => (value: string) => boolean;
const root = fileURLToPath(new URL("../", import.meta.url));
const options = { dot: true, contains: true };
const expectedExcludes = [
  "./vendor/braces/**/*",
  "./vendor/braces-3.0.3-local.tgz",
  "./vendor/upstream/braces-3.0.3.tgz",
  "./vendor/braces-provenance.json",
  "./vendor/braces-security.patch",
  "./vendor/braces-review-evidence.json",
  "./vendor/braces-integration-evidence.json",
  "./scripts/dependency-review/**/*",
  "./scripts/dependency-security/**/*",
  "./scripts/ci-audit.mjs",
  "./scripts/verify-braces-exception.mjs",
  "./scripts/verify-braces-runtime.mjs",
  "./lib/braces-exception-pins.mjs",
  "./lib/scoped-braces-exception.mjs",
  "./.dependency-audit/**/*",
];
const exclusions = nextConfig.outputFileTracingExcludes ?? {};
const routeMatchers = new Map<string, (file: string) => boolean>();
const routeFileMatches = new Map<string, Map<string, boolean>>();

function excluded(route: string, file: string): boolean {
  let results = routeFileMatches.get(route);
  if (!results) { results = new Map(); routeFileMatches.set(route, results); }
  const previous = results.get(file);
  if (previous !== undefined) return previous;
  let matcher = routeMatchers.get(route);
  if (!matcher) {
    const patterns = Object.entries(exclusions)
      .filter(([routeGlob]) => picomatch(routeGlob, options)(route))
      .flatMap(([, values]) => values.map((value) => path.join(root, value)));
    matcher = patterns.length > 0 ? picomatch(patterns, options) : () => false;
    routeMatchers.set(route, matcher);
  }
  const result = matcher(path.join(root, file));
  results.set(file, result);
  return result;
}

function files(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

const devLibraries = new Set(["lib/braces-exception-pins.mjs", "lib/scoped-braces-exception.mjs"]);
const developmentScripts = new Set([
  "scripts/ci-audit.mjs", "scripts/verify-braces-exception.mjs", "scripts/verify-braces-runtime.mjs",
]);
const retainedScripts = files("scripts").filter((file) => !developmentScripts.has(file)
  && !file.startsWith("scripts/dependency-review/") && !file.startsWith("scripts/dependency-security/"));
const runtimeSources = [...files("app"), ...files("components"), ...files("lib"), "proxy.ts"]
  .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !devLibraries.has(file));
// Bound each test's synchronous AST workload as the repository grows, without
// changing the timeout or excluding any source/import/candidate from the gate.
const sourceBatchSize = 100;
const sourceBatches = Array.from({ length: Math.ceil(runtimeSources.length / sourceBatchSize) }, (_, index) => ({
  number: index + 1,
  sources: runtimeSources.slice(index * sourceBatchSize, (index + 1) * sourceBatchSize),
}));

function importedModules(file: string, text = readFileSync(path.join(root, file), "utf8")): string[] {
  // The downward-only walk never consults parent pointers. Avoid constructing
  // a second link for every node in large runtime sources.
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const modules: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text);
    } else if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteralLike(node.expression)) {
      modules.push(node.expression.text);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      modules.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return modules;
}

describe("temporary development-only runtime tracing boundary", () => {
  it.each([
    ['import value from "@/lib/scoped-braces-exception";', ["@/lib/scoped-braces-exception"]],
    ['export * as value from "../scripts/dependency-security/tool.mjs";', ["../scripts/dependency-security/tool.mjs"]],
    ['export { value } from "./tool.mjs";', ["./tool.mjs"]],
    ['import value = require("./tool.mjs");', ["./tool.mjs"]],
    ['function nested() { return import(`./tool.mjs`); }', ["./tool.mjs"]],
    ['function nested() { return require(`./tool.mjs`); }', ["./tool.mjs"]],
    ['const node = <span>{require("./tool.mjs")}</span>;', ["./tool.mjs"]],
    ['const text = `${require("./tool.mjs")}`;', ["./tool.mjs"]],
    ['import "\\u002e/tool.mjs";', ["./tool.mjs"]],
    ['// require("./comment.mjs")\nconst text = \'import("./text.mjs")\';', []],
  ] as const)("retains literal module detection for %s", (source, expected) => {
    expect(importedModules("synthetic.tsx", source)).toEqual(expected);
  });

  it("has only the reviewed project-owned paths, without a node_modules or broad source exclusion", () => {
    expect(exclusions).toEqual({ "/**": expectedExcludes });
  });

  it("matches no real project source outside the explicitly approved development assets", () => {
    const approvedFiles = new Set(expectedExcludes.filter((glob) => !glob.includes("*")).map((file) => file.slice(2)));
    const approvedDirectories = ["vendor/braces/", "scripts/dependency-review/", "scripts/dependency-security/", ".dependency-audit/"];
    // Dependencies and generated build outputs are separately checked by the
    // runtime-artifact verifier. Inventory all actual project sources here.
    const generatedRoots = new Set(["node_modules", ".git", ".next", ".preflight"]);
    const projectFiles = readdirSync(root, { withFileTypes: true })
      .filter((entry) => !generatedRoots.has(entry.name))
      .flatMap((entry) => entry.isDirectory() ? files(entry.name) : [entry.name]);
    const matched = projectFiles.filter((file) => excluded("/api/settings/backup", file));
    expect(matched.length).toBeGreaterThan(20);
    for (const file of matched) {
      expect(approvedFiles.has(file) || approvedDirectories.some((directory) => file.startsWith(directory)), file).toBe(true);
    }
  });

  it("excludes all current review assets and generated proof from every server-route trace", () => {
    const assets = [
      ...files("vendor/braces"), ...files("scripts/dependency-review"), ...files("scripts/dependency-security"),
      ...expectedExcludes.filter((glob) => !glob.includes("*")),
      ".dependency-audit/exception-proof.json", ".dependency-audit/runtime-proof.json",
      ".dependency-audit/full-attempt-1.json", ".dependency-audit/.nested/production-attempt-1.process.json",
    ];
    for (const route of ["/", "/api/backup/full", "/api/settings/backup", "/api/settings/backup/restore", "/patients/[id]"]) {
      for (const file of assets) expect(excluded(route, file), `${route}: ${file}`).toBe(true);
    }
  });

  it("retains core source, immutable migrations, preflight files and genuine runtime packages", () => {
    const retained = [
      ...runtimeSources, ...retainedScripts, ...files("migrations"), ...files("schema"),
      "scripts/backup.mjs", "scripts/restore.mjs", "scripts/backup-full.mts", "scripts/restore-full.ts",
      "scripts/build-preflight.ts", "scripts/db-preflight.ts", "scripts/db-preflight-entry.ts",
      ".preflight/runner/run.mjs", ".preflight/manifest.json", ".preflight/migrations/0001_init.sql",
      "node_modules/braces/index.js", "node_modules/braces/package.json",
      "node_modules/tool/node_modules/braces/lib/parse.js",
      "node_modules/next/dist/server/next-server.js", "node_modules/pg/lib/index.js",
      "node_modules/@electric-sql/pglite/dist/pglite.wasm", "node_modules/react/index.js",
      "vendor/runtime/index.js", "vendor/upstream/runtime.tgz", "vendor/braces-runtime/index.js",
      "scripts/dependency-runtime/index.js", "scripts/verify-braces-runtime-production.mjs",
      "lib/scoped-braces-runtime.mjs", "lib/runtime-braces-exception-pins.mjs",
    ];
    for (const file of retained) expect(excluded("/api/backup/full", file), file).toBe(false);
  });

  it("covers every runtime source exactly once in the bounded import scans", () => {
    expect(runtimeSources.length).toBeGreaterThan(600);
    expect(sourceBatches.flatMap(batch => batch.sources)).toEqual(runtimeSources);
    expect(new Set(runtimeSources).size).toBe(runtimeSources.length);
    expect(sourceBatches.every(batch => batch.sources.length > 0 && batch.sources.length <= sourceBatchSize)).toBe(true);
  });

  it.each(sourceBatches)("does not let runtime imports depend on excluded development tooling (batch $number)", ({ sources }) => {
    const violations: string[] = [];
    for (const file of sources) {
      for (const specifier of importedModules(file)) {
        const target = specifier.startsWith("@/") ? specifier.slice(2)
          : specifier.startsWith(".") ? path.relative(root, path.resolve(root, path.dirname(file), specifier))
          : `node_modules/${specifier}`;
        // Extensionless imports resolve to the same reviewed module too.
        for (const candidate of [target, `${target}.mjs`, `${target}/index.mjs`]) {
          if (excluded("/api/backup/full", candidate)) violations.push(`${file} imports ${specifier} → ${candidate}`);
        }
      }
    }
    // Keep every source/import/candidate check, with all offending paths on
    // failure, without constructing thousands of passing assertion objects.
    expect(violations).toEqual([]);
  });
});

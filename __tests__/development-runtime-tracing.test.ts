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

// nextConfig and the matcher options are immutable inputs for this test file.
// Compile their globs once; retain a distinct file matcher for each exact route.
const configuredRouteMatchers = Object.entries(exclusions).map(([routeGlob, values]) => ({
  matchesRoute: picomatch(routeGlob, options),
  patterns: values.map((value) => path.join(root, value)),
}));
const routeFileMatchers = new Map<string, (file: string) => boolean>();

function excluded(route: string, file: string): boolean {
  let matcher = routeFileMatchers.get(route);
  if (!matcher) {
    const patterns = configuredRouteMatchers
      .filter(({ matchesRoute }) => matchesRoute(route))
      .flatMap(({ patterns }) => patterns);
    matcher = patterns.length > 0 ? picomatch(patterns, options) : () => false;
    routeFileMatchers.set(route, matcher);
  }
  return matcher(path.join(root, file));
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

function importedModules(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
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

  it("keeps cached matchers equivalent to the original glob oracle for all configured patterns and edge paths", () => {
    // The original implementation remains the independent oracle for this
    // bounded corpus, including dot:true/contains:true and path normalization.
    const originalExcluded = (route: string, file: string): boolean => {
      const patterns = Object.entries(exclusions)
        .filter(([routeGlob]) => picomatch(routeGlob, options)(route))
        .flatMap(([, values]) => values.map((value) => path.join(root, value)));
      return patterns.length > 0 && picomatch(patterns, options)(path.join(root, file));
    };
    const patternWitnesses = Object.values(exclusions).flat().flatMap((pattern) => {
      const relative = pattern.replace(/^\.\//, "");
      return relative.endsWith("/**/*")
        ? [relative.replace(/\/\*\*\/\*$/, "/index.js"),
          relative.replace(/\/\*\*\/\*$/, "/.hidden/nested.js"),
          relative.replace(/\/\*\*\/\*$/, "/nested/.proof.json")]
        : [relative];
    });
    const witnesses = [...patternWitnesses,
      "app/api/backup/full/route.ts", "components/Modal.tsx", "lib/db.ts",
      "migrations/0050_hr_payroll_integrity.sql", "schema/current-schema-contract.pg18.json",
      "node_modules/braces/index.js", "node_modules/tool/node_modules/braces/lib/parse.js",
      "vendor/braces-runtime/index.js", "vendor/upstream/runtime.tgz",
      "scripts/dependency-review-runtime/check.ts", "scripts/dependency-security-runtime/check.ts",
      "lib/scoped-braces-exception", "lib/scoped-braces-exception.mjs.backup",
      "vendor/braces/../runtime/index.js", "./.dependency-audit/.nested/proof.json",
    ];
    for (const route of ["/", "/api/backup/full", "/api/settings/backup", "/patients/[id]", "/.hidden", "/api/backup/full?probe=1"]) {
      for (const file of [...witnesses, ...witnesses.slice().reverse()]) {
        expect(excluded(route, file), `${route}: ${file}`).toBe(originalExcluded(route, file));
      }
    }
  });

  it("does not let runtime app, component or library imports depend on excluded development tooling", () => {
    expect(runtimeSources.length).toBeGreaterThan(600);
    for (const file of runtimeSources) {
      for (const specifier of importedModules(file)) {
        const target = specifier.startsWith("@/") ? specifier.slice(2)
          : specifier.startsWith(".") ? path.relative(root, path.resolve(root, path.dirname(file), specifier))
          : `node_modules/${specifier}`;
        // Extensionless imports resolve to the same reviewed module too.
        for (const candidate of [target, `${target}.mjs`, `${target}/index.mjs`]) {
          expect(excluded("/api/backup/full", candidate), `${file} imports ${specifier}`).toBe(false);
        }
      }
    }
  });
});

#!/usr/bin/env node
import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRuntimeArtifacts } from "../verify-braces-runtime.mjs";
import { sha256 } from "./installed-braces.mjs";

const exactNames = new Set(["minimatch", "eslint", "eslint-plugin-react-hooks", "typescript-eslint"]);
const namespaces = ["@eslint/", "@eslint-community/", "@typescript-eslint/"];
const denied = name => typeof name === "string" && (exactNames.has(name) || namespaces.some(prefix => name.startsWith(prefix)));
const assert = (value, message) => { if (!value) throw new Error(`LINT_TOOLING_RUNTIME_REJECTED: ${message}`); };
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const slash = value => value.replace(/\\/g, "/");

// Source names are URLs, bundler paths, or bare package subpaths. Check raw and
// normalized forms before stripping query/fragment or decoding percent escapes.
export function toolingSourcePath(value) {
  assert(typeof value === "string", "source path is not a string");
  let current = slash(value);
  for (let depth = 0; depth < 5; depth++) {
    for (const candidate of [current, path.posix.normalize(current), current.split(/[?#]/, 1)[0], path.posix.normalize(current.split(/[?#]/, 1)[0])]) {
      const segments = candidate.split("/");
      for (let index = 0; index < segments.length; index++) {
        const name = segments[index].startsWith("@") ? `${segments[index]}/${segments[index + 1] ?? ""}` : segments[index];
        if (denied(name)) return true;
      }
    }
    let decoded;
    try { decoded = decodeURIComponent(current); } catch { throw new Error("LINT_TOOLING_RUNTIME_REJECTED: malformed path encoding"); }
    if (decoded === current) return false;
    current = slash(decoded);
  }
  throw new Error("LINT_TOOLING_RUNTIME_REJECTED: excessive path encoding");
}

/** Actual npm production graph, not lockfile dev annotations. No subprocess in fixtures. */
export function verifyProductionToolingGraph(graph) {
  assert(record(graph) && record(graph.dependencies), "missing production dependency graph");
  let packages = 0;
  const visit = (node, edgeName = null) => {
    assert(record(node), "malformed production graph node");
    assert(!denied(edgeName) && !denied(node.name), `tooling in production dependency graph: ${node.name ?? edgeName}`);
    assert(!node.invalid && !node.missing && !node.extraneous && (!node.problems || Array.isArray(node.problems) && node.problems.length === 0), "invalid production dependency graph");
    if (edgeName !== null) packages++;
    if (node.dependencies !== undefined) {
      assert(record(node.dependencies), "malformed production dependency edges");
      for (const [name, child] of Object.entries(node.dependencies)) visit(child, name);
    }
  };
  visit(graph);
  assert(packages > 0, "empty production dependency traversal");
  return { packageOccurrences: packages, graphSha256: sha256(JSON.stringify(graph)) };
}

async function inspectAncestorManifests(file, root) {
  let directory = path.dirname(file);
  while (directory !== root) {
    assert(directory.startsWith(`${root}${path.sep}`), "trace source escapes project");
    const manifest = path.join(directory, "package.json");
    let stat;
    try { stat = await lstat(manifest); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat) {
      assert(stat.isFile() && !stat.isSymbolicLink(), "non-file trace package manifest");
      const pkg = JSON.parse(await readFile(manifest, "utf8"));
      assert(record(pkg) && (pkg.name === undefined || typeof pkg.name === "string"), "malformed trace package manifest");
      assert(!denied(pkg.name), `renamed tooling trace package: ${pkg.name}`);
    }
    directory = path.dirname(directory);
  }
}
function inspectMap(map) {
  // The unchanged braces verifier has already validated shape, indexed maps,
  // external sections and source-content cardinality. This adds identities only.
  for (const value of [map.file, map.sourceRoot, ...(map.sources ?? [])]) {
    if (value !== undefined) assert(!toolingSourcePath(value), `tooling source-map input: ${value}`);
  }
  for (const source of map.sources ?? []) assert(!toolingSourcePath(`${map.sourceRoot ?? ""}/${source}`), "tooling joined source-map input");
  for (const section of map.sections ?? []) inspectMap(section.map);
}

export async function verifyLintToolingRuntime(projectRoot) {
  const root = await realpath(projectRoot);
  // Reuse the strict inventory and known Next alias validation. No new symlink
  // allowance or weaker traversal replaces the reviewed braces guard.
  const provenance = await verifyRuntimeArtifacts(root);
  assert(Object.keys(provenance.files).length > 0 && provenance.traceCount > 1, "empty artifact provenance");
  let manifests = 0, maps = 0, traces = 0;
  for (const [relative, digest] of Object.entries(provenance.files)) {
    assert(!toolingSourcePath(relative), `tooling artifact path: ${relative}`);
    const file = path.resolve(root, relative);
    assert(file.startsWith(`${root}${path.sep}`), "artifact path escapes project");
    const bytes = await readFile(file);
    assert(sha256(bytes) === digest, `artifact changed during verification: ${relative}`);
    if (relative.endsWith("package.json")) {
      const pkg = JSON.parse(bytes.toString("utf8"));
      assert(record(pkg) && (pkg.name === undefined || typeof pkg.name === "string"), `malformed manifest: ${relative}`);
      assert(!denied(pkg.name), `tooling package identity shipped: ${pkg.name}`);
      manifests++;
    }
    if (relative.endsWith(".map")) { inspectMap(JSON.parse(bytes.toString("utf8"))); maps++; }
    if (relative.endsWith(".nft.json")) {
      const trace = JSON.parse(bytes.toString("utf8"));
      assert(record(trace) && trace.version === 1 && Array.isArray(trace.files) && trace.files.length > 0 && trace.files.every(input => typeof input === "string"), `malformed NFT metadata: ${relative}`);
      for (const input of trace.files) {
        assert(!toolingSourcePath(input), `tooling NFT input: ${input}`);
        const physical = await realpath(path.resolve(path.dirname(file), input));
        assert(!toolingSourcePath(physical), `tooling physical NFT input: ${input}`);
        await inspectAncestorManifests(physical, root);
      }
      traces++;
    }
  }
  assert(manifests > 0 && traces >= provenance.traceCount, "missing manifest or NFT inspection");
  for (const pkg of provenance.preflightBundledPackages) assert(!denied(pkg.name), `tooling preflight input: ${pkg.name}`);
  return { format: "aqlan-lint-tooling-runtime-absence-v1", buildId: provenance.buildId,
    packageSha256: provenance.packageSha256, lockSha256: provenance.lockSha256,
    checkedRoots: provenance.checkedRoots, exactNames: [...exactNames], namespaces,
    manifestCount: manifests, traceCount: traces, sourceMapCount: maps,
    mapCoverage: "Only available validated maps are inspected. Empty indexed maps give zero source attribution. Unmapped/minified arbitrary bundled code is not proven absent.",
    scope: "Exact tooling package identities, artifact paths, NFT/source-map/preflight inputs, plus separately verified npm production graph. Root devDependency declarations are not installed runtime copies.",
    files: provenance.files, preflightBundledPackages: provenance.preflightBundledPackages,
    runtimeModuleAliases: provenance.runtimeModuleAliases, productionGraph: null };
}
const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  try {
    assert(process.argv.length === 2, "verifier accepts no flags");
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const result = spawnSync("npm", ["ls", "--omit=dev", "--all", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 120_000 });
    assert(!result.error && result.status === 0, "npm production graph command failed");
    const graph = verifyProductionToolingGraph(JSON.parse(result.stdout));
    const proof = await verifyLintToolingRuntime(root);
    proof.productionGraph = graph;
    await writeFile(path.join(root, ".dependency-audit/lint-tooling-runtime-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
    console.log(`Lint tooling runtime inputs absent for build ${proof.buildId}; ${proof.traceCount} traces, ${proof.manifestCount} manifests. Available maps only; no opaque-code claim.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

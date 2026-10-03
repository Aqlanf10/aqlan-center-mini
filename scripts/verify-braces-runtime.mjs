#!/usr/bin/env node
import { createRequire } from "node:module";
import { lstat, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRACES_EXCEPTION as PIN } from "../lib/braces-exception-pins.mjs";
import { invariant, isRecord } from "../lib/scoped-braces-exception.mjs";
import { fileInventory, jsonFile, sha256, slash } from "./dependency-security/installed-braces.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const bracesPath = (name) => /(?:^|[/\\])(?:node_modules[/\\]|vendor[/\\])braces(?:[/\\]|\.(?:js|json|node)$|$)/.test(name)
  || /(?:^|[/\\])braces-3\.0\.3(?:-local)?\.tgz$/.test(name);
const bracesImport = /\b(?:require\s*\(|(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?|import\s*\()\s*["']braces(?:["'/])/;
const marker = /BRACES_(?:NESTING_LIMIT|INVALID_AST)|micromatch\/braces(?:\/|["'])/;

export async function verifyRuntimeArtifacts(projectRoot = root) {
  const roots = [".next/standalone", ".next/static", ".preflight"];
  for (const required of [".next/BUILD_ID", ".next/standalone/server.js", ".next/standalone/package.json", ".next/next-server.js.nft.json", ".preflight/manifest.json", ".preflight/runner/run.mjs"]) {
    invariant((await lstat(path.join(projectRoot, required))).isFile(), `required runtime artifact missing/non-file: ${required}`);
  }
  const buildId = (await readFile(path.join(projectRoot, ".next/BUILD_ID"), "utf8")).trim();
  invariant(buildId.length > 0, "missing build identity");
  const inventory = {};
  const packageFiles = [];
  let sourceMaps = 0;
  let traces = 0;
  function checkSourceMap(map, location) {
    invariant(isRecord(map) && map.version === 3, `malformed source map: ${location}`);
    if (Array.isArray(map.sections)) {
      invariant(map.sections.length > 0, `empty source-map sections: ${location}`);
      for (const section of map.sections) { invariant(isRecord(section) && isRecord(section.map), "external/unknown source map section"); checkSourceMap(section.map, location); }
      return;
    }
    invariant(Array.isArray(map.sources) && map.sources.every((source) => typeof source === "string"), `missing source map inputs: ${location}`);
    invariant(map.sourceRoot === undefined || typeof map.sourceRoot === "string", "invalid source-map sourceRoot");
    invariant(!bracesPath(map.sourceRoot ?? ""), "braces sourceRoot in bundled code");
    for (const source of map.sources) invariant(!bracesPath(`${map.sourceRoot ?? ""}/${source}`) && !/^(?:webpack:\/\/)?braces(?:\/|$)/.test(source), `bundled braces source input: ${source}`);
    if (map.sourcesContent !== undefined) {
      invariant(Array.isArray(map.sourcesContent) && map.sourcesContent.length === map.sources.length, "source-map content mismatch");
      for (const source of map.sourcesContent) {
        invariant(source === null || typeof source === "string", "invalid source-map content");
        if (source) invariant(!bracesImport.test(source) && !marker.test(source), `bundled braces code evidence: ${location}`);
      }
    }
  }
  for (const artifactRoot of roots) {
    const files = await fileInventory(path.join(projectRoot, artifactRoot));
    invariant(Object.keys(files).length > 0, `empty runtime artifact: ${artifactRoot}`);
    for (const [relative, digest] of Object.entries(files)) {
      const location = `${artifactRoot}/${relative}`;
      inventory[location] = digest;
      invariant(!bracesPath(relative), `braces artifact shipped: ${location}`);
      if (relative.endsWith("package.json")) {
        const pkg = await jsonFile(path.join(projectRoot, location));
        invariant(isRecord(pkg) && pkg.name !== PIN.package, `braces package shipped: ${location}`);
        packageFiles.push(location);
      }
      if (/\.(?:js|cjs|mjs)$/.test(relative)) {
        // Supplemental positive detection, not a claim that arbitrary opaque
        // third-party minified code has been universally re-audited.
        const source = await readFile(path.join(projectRoot, location), "utf8");
        invariant(!bracesImport.test(source) && !marker.test(source), `braces code/import shipped: ${location}`);
        invariant(!Object.values(PIN.files).includes(digest), `known braces source bytes shipped: ${location}`);
      }
      if (relative.endsWith(".map")) { checkSourceMap(await jsonFile(path.join(projectRoot, location)), location); sourceMaps += 1; }
    }
  }
  // Trace the actual build, including NFT files not copied into standalone.
  const pending = [path.join(projectRoot, ".next")];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "standalone" || entry.name === "cache" || entry.name === "static") continue;
      const full = path.join(directory, entry.name);
      invariant(!entry.isSymbolicLink(), "symlink in build trace tree");
      if (entry.isDirectory()) pending.push(full);
      else if (entry.name.endsWith(".nft.json")) {
        const trace = await jsonFile(full);
        invariant(isRecord(trace) && trace.version === 1 && Array.isArray(trace.files) && trace.files.every((file) => typeof file === "string"), "invalid NFT input inventory");
        invariant(trace.files.length > 0, "empty NFT input inventory");
        for (const file of trace.files) {
          const input = path.resolve(path.dirname(full), file);
          invariant(input.startsWith(`${path.resolve(projectRoot)}${path.sep}`), "NFT input escapes project");
          invariant(!bracesPath(slash(input)), `braces input in runtime NFT trace: ${file}`);
          invariant((await lstat(input)).isFile(), `NFT input missing/non-file: ${file}`);
        }
        inventory[slash(path.relative(projectRoot, full))] = sha256(await readFile(full));
        traces += 1;
      }
    }
  }
  invariant(traces > 1 && sourceMaps > 0, "missing app runtime trace/source-map provenance");
  const standalone = path.join(projectRoot, ".next/standalone");
  for (const pkgFile of packageFiles.filter((file) => file.startsWith(".next/standalone/"))) {
    const require = createRequire(path.join(projectRoot, pkgFile));
    // Limit lookup to the shipped artifact. Build-time node_modules above this
    // directory is deliberately not part of the runner image or this proof.
    for (const search of require.resolve.paths(PIN.package) ?? []) {
      if (!(search === standalone || search.startsWith(`${standalone}${path.sep}`))) continue;
      try { await lstat(path.join(search, PIN.package)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      throw new Error(`BRACES_EXCEPTION_REJECTED: shipped consumer can resolve braces: ${pkgFile}`);
    }
  }
  const preflight = await jsonFile(path.join(projectRoot, ".preflight/manifest.json"));
  invariant(preflight.format === "aqlan-read-only-preflight-artifact" && preflight.formatVersion === 2
    && Array.isArray(preflight.bundledPackages) && preflight.bundledPackages.length > 0, "missing preflight bundler package provenance");
  invariant(preflight.bundledPackages.every((pkg) => isRecord(pkg) && typeof pkg.name === "string" && typeof pkg.version === "string" && pkg.name !== PIN.package), "braces/invalid package in preflight bundler inputs");
  invariant(preflight.bundleSha256 === inventory[".preflight/runner/run.mjs"] && preflight.noticesSha256 === inventory[".preflight/THIRD_PARTY_NOTICES.txt"], "preflight provenance does not bind shipped bytes");
  const proof = { format: "aqlan-braces-runtime-absence-v1", checkedAt: new Date().toISOString(), buildId,
    packageSha256: sha256(await readFile(path.join(projectRoot, "package.json"))),
    lockSha256: sha256(await readFile(path.join(projectRoot, "package-lock.json"))),
    freshness: "Build freshness is established by clean CI/Docker assembly immediately before this check; invoking this verifier alone does not rebuild artifacts.",
    checkedRoots: roots, shippedPackageManifests: packageFiles.sort(), traceCount: traces, sourceMapCount: sourceMaps,
    preflightBundledPackages: preflight.bundledPackages, files: inventory,
    scope: "Exact npm braces package, resolvable copies, build trace/source-map inputs and known code identities. Not a universal security audit of opaque third-party internals." };
  await mkdir(path.join(projectRoot, ".dependency-audit"), { recursive: true });
  await writeFile(path.join(projectRoot, ".dependency-audit/runtime-proof.json"), JSON.stringify(proof, null, 2) + "\n");
  return proof;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { invariant(process.argv.length === 2, "runtime verifier accepts no flags"); const proof = await verifyRuntimeArtifacts(); console.log(`Runtime braces absence verified for build ${proof.buildId}: ${Object.keys(proof.files).length} shipped/provenance files, ${proof.traceCount} traces.`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

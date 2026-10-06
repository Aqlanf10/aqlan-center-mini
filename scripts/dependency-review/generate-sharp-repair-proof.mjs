// Temporary isolated evidence generator. Never used by the release gate.
// npm generates the candidate lock; every unrelated byte-level input and
// unrelated lock entry is preserved. No Production credentials or data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateScopedAudit, validateAuditProcess } from "../../lib/scoped-braces-exception.mjs";
import { verifyBracesException } from "../verify-braces-exception.mjs";

const BASE = "ea312ad872897b07ad2241c09084837dee355dae";
const TREE = "9e25e552461bbff6a38d4e06bc70a3d6eafd21d9";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] || join(repository, ".sharp-repair-proof"));
const work = mkdtempSync(join(tmpdir(), "aqlan-sharp-proof-"));
const candidate = join(work, "root-candidate");
const registry = "https://registry.npmjs.org";
const fixturePath = "scripts/dependency-review/consumer-fixture";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = file => JSON.parse(readFileSync(file, "utf8"));
const commands = [];
mkdirSync(output, { recursive: true });
mkdirSync(candidate);
const npmOptions = ["--registry=" + registry, "--cache=" + join(work, "npm-cache"), "--fetch-retries=0", "--fetch-timeout=60000", "--maxsockets=2"];
const save = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
function run(label, executable, args, cwd = repository, allowed = [0], timeout = 180000) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  const record = { label, executable, args, code: result.status, signal: result.signal, error: result.error?.code ?? null,
    stdoutSha256: hash(result.stdout || ""), stderrSha256: hash(result.stderr || "") };
  commands.push(record);
  save("commands.json", commands);
  // Retain both channels even when a subsequent assertion fails.
  writeFileSync(join(work, label + ".stdout.txt"), result.stdout || "");
  writeFileSync(join(work, label + ".stderr.txt"), result.stderr || "");
  assert(allowed === null || (!result.error && result.signal === null && allowed.includes(result.status)),
    label + " failed: " + JSON.stringify(record) + "\n" + result.stderr);
  return result;
}
function base(path) {
  return run("read-base-" + path.replaceAll("/", "-"), "git", ["show", BASE + ":" + path]).stdout;
}
function audit(label, directory, production = false) {
  const result = run(label, "npm", ["audit", "--json", "--audit-level=moderate", ...(production ? ["--omit=dev"] : []), ...npmOptions], directory, null);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  writeFileSync(join(output, label + ".json"), stdout);
  writeFileSync(join(output, label + ".stderr.txt"), stderr);
  save(label + ".process.json", { code: result.status ?? null, signal: result.signal ?? null, error: result.error === undefined ? null : String(result.error), registry });
  const evidence = { report: JSON.parse(stdout), code: result.status, signal: result.signal, error: result.error,
    stdout, stderr };
  if (production) validateAuditProcess(evidence, true);
  else {
    validateScopedAudit(evidence);
    assert.deepEqual(evidence.report.metadata.vulnerabilities,
      { info: 0, low: 0, moderate: 0, high: 6, critical: 0, total: 6 },
      "Candidate audit must retain exactly the existing six HIGH braces-chain nodes");
    assert.deepEqual(Object.keys(evidence.report.vulnerabilities).sort(),
      ["@next/eslint-plugin-next", "braces", "chokidar", "fast-glob", "micromatch", "tailwindcss"]);
  }
  return evidence;
}
try {
  assert.equal(Number(process.versions.node.split(".")[0]), 22);
  const npmVersion = run("npm-version", "npm", ["--version"]).stdout.trim();
  assert.equal(Number(npmVersion.split(".")[0]), 11);
  assert.equal(run("verify-base-tree", "git", ["rev-parse", BASE + "^{tree}"]).stdout.trim(), TREE);
  const changedSourcePaths = run("source-delta", "git", ["diff", "--name-only", BASE, "HEAD"]).stdout.trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(changedSourcePaths, [
    ".github/workflows/sharp-resolution-proof.yml",
    "scripts/dependency-review/generate-sharp-repair-proof.mjs",
    "scripts/dependency-review/sharp-runtime-worker.mjs",
  ], "The temporary proof commit must add only its three reviewed proof files");
  const manifestBytes = base("package.json");
  const lockBytes = base("package-lock.json");
  const original = JSON.parse(lockBytes);
  assert.equal(readFileSync(join(repository, "package.json"), "utf8"), manifestBytes);
  assert.equal(readFileSync(join(repository, "package-lock.json"), "utf8"), lockBytes);
  assert.equal(original.packages["node_modules/next"].version, "16.3.8");
  assert.equal(original.packages["node_modules/next"].optionalDependencies.sharp, "^0.35.4");
  const family = Object.keys(original.packages).filter(path => /^node_modules\/(?:@img\/sharp-|sharp$)/.test(path)).sort();
  assert.equal(family.length, 27);
  const published = {};
  const archiveFileHashes = {};
  for (const location of family) {
    const name = location.slice("node_modules/".length);
    const version = name.startsWith("@img/sharp-libvips-") ? "1.3.4" : "0.35.5";
    const label = name.replaceAll("/", "-").replace("@", "");
    const metadata = JSON.parse(run("metadata-" + label, "npm", ["view", name + "@" + version, "--json", ...npmOptions]).stdout);
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, version);
    assert.equal(metadata.dist?.tarball, registry + "/" + name + "/-/" + name.split("/").at(-1) + "-" + version + ".tgz");
    assert.match(metadata.dist?.integrity || "", /^sha512-[A-Za-z0-9+/]+=*$/);
    const packed = JSON.parse(run("pack-" + label, "npm", ["pack", name + "@" + version, "--ignore-scripts", "--json", "--pack-destination=" + work, ...npmOptions]).stdout);
    assert.equal(packed.length, 1);
    assert.equal(packed[0].name, name);
    assert.equal(packed[0].version, version);
    assert.match(packed[0].filename, /^[a-z0-9.-]+\.tgz$/);
    const archive = join(work, packed[0].filename);
    const bytes = readFileSync(archive);
    const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
    assert.equal(integrity, metadata.dist.integrity);
    assert.equal(integrity, packed[0].integrity);
    assert(Array.isArray(packed[0].files) && packed[0].files.length > 0);
    for (const file of packed[0].files) assert(typeof file.path === "string" && !file.path.startsWith("/") && !file.path.split("/").includes(".."));
    published[name] = { ...metadata, verifiedArchiveSha256: hash(bytes), verifiedArchiveBytes: bytes.length, files: packed[0].files };
    const fileHashes = {};
    for (const file of packed[0].files) {
      const unpacked = spawnSync("tar", ["-xOf", archive, "package/" + file.path],
        { encoding: null, timeout: 30000, maxBuffer: 256 * 1024 * 1024 });
      assert(!unpacked.error && unpacked.status === 0 && unpacked.signal === null,
        "Cannot inspect verified archive file: " + name + "/" + file.path);
      assert.equal(unpacked.stdout.length, file.size);
      fileHashes[file.path] = hash(unpacked.stdout);
    }
    archiveFileHashes[name] = fileHashes;
    save("official-package-files.json", archiveFileHashes);
    save("official-packages.json", published);
  }
  assert.equal(published.sharp.config.libvips, ">=8.18.7");
  writeFileSync(join(candidate, "package.json"), manifestBytes);
  writeFileSync(join(candidate, "package-lock.json"), lockBytes);
  cpSync(join(repository, "vendor"), join(candidate, "vendor"), { recursive: true });
  run("generate-root-lock", "npm", ["update", "sharp", "--package-lock-only", "--ignore-scripts", "--no-fund", "--audit=true", ...npmOptions], candidate);
  assert.equal(readFileSync(join(candidate, "package.json"), "utf8"), manifestBytes);
  const generatedBytes = readFileSync(join(candidate, "package-lock.json"));
  copyFileSync(join(candidate, "package-lock.json"), join(output, "root-package-lock.json"));
  const generated = JSON.parse(generatedBytes);
  const previousTop = { ...original }; delete previousTop.packages;
  const nextTop = { ...generated }; delete nextTop.packages;
  assert.deepEqual(nextTop, previousTop);
  assert.deepEqual(Object.keys(generated.packages).sort(), Object.keys(original.packages).sort(), "Package inventory drift");
  const expectedFamilyNames = new Set(family.map(path => path.slice("node_modules/".length)));
  const replaceFamilyVersions = map => map && Object.fromEntries(Object.entries(map).map(([name, version]) => [
    name, expectedFamilyNames.has(name) ? published[name].version : version,
  ]));
  const changes = [];
  for (const [location, next] of Object.entries(generated.packages)) {
    const previous = original.packages[location];
    if (!family.includes(location)) {
      assert.deepEqual(next, previous, "Unrelated lock drift: " + location);
      continue;
    }
    const name = location.slice("node_modules/".length);
    const metadata = published[name];
    const expected = { ...previous, version: metadata.version, resolved: metadata.dist.tarball, integrity: metadata.dist.integrity };
    for (const field of ["license", "engines", "cpu", "os", "libc"]) {
      if (Object.hasOwn(metadata, field)) expected[field] = metadata[field];
      else delete expected[field];
    }
    assert(!metadata.scripts?.install && !metadata.scripts?.preinstall && !metadata.scripts?.postinstall,
      "Unexpected new package installation lifecycle");
    if (previous.dependencies) expected.dependencies = replaceFamilyVersions(previous.dependencies);
    if (previous.optionalDependencies) expected.optionalDependencies = replaceFamilyVersions(previous.optionalDependencies);
    assert.deepEqual(next, expected, "Unexpected sharp-family lock metadata: " + location);
    for (const field of ["dependencies", "optionalDependencies", "engines", "cpu", "os", "libc"])
      assert.deepEqual(next[field] || (["cpu", "os", "libc"].includes(field) ? [] : {}), metadata[field] || (["cpu", "os", "libc"].includes(field) ? [] : {}), name + " metadata mismatch: " + field);
    assert.equal(next.license, metadata.license);
    changes.push({ path: location, before: previous.version, after: next.version, archiveSha256: metadata.verifiedArchiveSha256 });
  }
  save("lock-delta.json", changes);
  const preservedInputs = {};
  for (const path of ["package.json", fixturePath + "/package.json", fixturePath + "/package-lock.json",
    "lib/scoped-braces-exception.mjs", "lib/braces-exception-pins.mjs",
    "scripts/dependency-security/reviewed-overrides.mjs", "scripts/ci-audit.mjs",
    "scripts/verify-braces-exception.mjs", "scripts/verify-braces-runtime.mjs"]) {
    const before = base(path);
    assert.equal(readFileSync(join(repository, path), "utf8"), before, "Protected input changed: " + path);
    preservedInputs[path] = hash(before);
  }
  run("install-root", "npm", ["ci", "--ignore-scripts", "--no-fund", "--audit=true", ...npmOptions], candidate, [0], 300000);
  assert.equal(hash(readFileSync(join(candidate, "package-lock.json"))), hash(generatedBytes));
  const full = audit("candidate-full-audit", candidate);
  const production = audit("candidate-production-audit", candidate, true);
  const exception = await verifyBracesException(full, production, candidate);
  save("exception-proof.json", exception);
  // Compare all real installed sharp-family regular files to independently
  // SHA-512-verified official archives. This includes actual native binaries.
  const installedPackageBytes = {};
  for (const location of family) {
    const name = location.slice("node_modules/".length);
    const installed = join(candidate, location);
    let pkg;
    try { pkg = json(join(installed, "package.json")); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, published[name].version);
    const files = {};
    for (const entry of published[name].files) {
      const actual = readFileSync(join(installed, entry.path));
      assert.equal(hash(actual), archiveFileHashes[name][entry.path], "Installed sharp-family bytes differ: " + location + "/" + entry.path);
      files[entry.path] = hash(actual);
    }
    installedPackageBytes[name] = files;
  }
  assert(Object.hasOwn(installedPackageBytes, "sharp"));
  assert(Object.hasOwn(installedPackageBytes, "@img/sharp-linux-x64"));
  assert(Object.hasOwn(installedPackageBytes, "@img/sharp-libvips-linux-x64"));
  save("installed-package-bytes.json", installedPackageBytes);
  // The original fixture has no sharp dependency. Install and test its exact
  // existing bytes rather than fabricating an unrelated fixture lock change.
  const consumer = join(work, "consumer"); mkdirSync(consumer);
  for (const name of ["package.json", "package-lock.json"])
    copyFileSync(join(repository, fixturePath, name), join(consumer, name));
  assert(!Object.keys(json(join(consumer, "package-lock.json")).packages).some(path => /(?:^|\/)(sharp|next)$|@img\/sharp-/.test(path)));
  copyFileSync(join(repository, "vendor/braces-3.0.3-local.tgz"), join(consumer, "braces-local-candidate.tgz"));
  run("install-consumer", "npm", ["ci", "--ignore-scripts", "--no-fund", "--audit=true", ...npmOptions], consumer, [0], 300000);
  assert.equal(readFileSync(join(consumer, "package-lock.json"), "utf8"), base(fixturePath + "/package-lock.json"));
  const consumerResult = run("consumer-chains", process.execPath, [join(repository, "scripts/dependency-review/braces-consumer-worker.mjs"), consumer, "candidate"], repository, [0], 60000);
  writeFileSync(join(output, "consumer-chains.json"), consumerResult.stdout);
  // The subsequent container steps are the only image-execution stages. They
  // run with --network=none and are validated separately before acceptance.
  save("generation-proof.json", {
    status: "lock generation, provenance, installed bytes and audit passed; runtime container proof still required",
    baseCommit: BASE, baseTree: TREE, proofCommit: run("proof-commit", "git", ["rev-parse", "HEAD"]).stdout.trim(),
    node: process.version, npm: npmVersion, originalLockSha256: hash(lockBytes),
    generatedLockSha256: hash(generatedBytes), changedPackages: changes, preservedInputs,
    limitations: ["No application release CI, PostgreSQL, HTTP/browser or Railway verification", "This temporary workflow must not enter the release tree"],
  });
  // Exact fixed paths are consumed by subsequent workflow steps, not uploaded.
  writeFileSync(join(output, "candidate-directory.txt"), candidate + "\n");
  console.log("Candidate root lock and immutable official evidence retained.");
} catch (error) {
  save("failure.json", { status: "failed; no release conclusion", message: error.message });
  console.error(error);
  process.exitCode = 1;
}

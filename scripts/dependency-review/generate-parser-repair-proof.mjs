// Temporary isolated evidence generator. Never invoked by the release gate.
// It writes generated locks/evidence only into its named output directory and
// installs only disposable consumer fixtures. It does not write the checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEWED_OVERRIDES, validateReviewedOverrides } from "../dependency-security/reviewed-overrides.mjs";
import { validateScopedAudit, validateAuditProcess } from "../../lib/scoped-braces-exception.mjs";

const BASE = "212d4740b6862e5fc72631c96bebb7fc96ec451d";
const TREE = "c83337b21c7eb211fe98e0a0d739923bf9fa43f7";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const output = resolve(process.argv[2] || join(repo, ".dependency-repair-proof"));
const work = mkdtempSync(join(tmpdir(), "aqlan-dependency-repair-"));
mkdirSync(output, { recursive: true });
const json = file => JSON.parse(readFileSync(file, "utf8"));
const hash = value => createHash("sha256").update(value).digest("hex");
const commands = [];
const registry = "https://registry.npmjs.org";
const npmOptions = ["--registry=" + registry, "--cache=" + join(work, "npm-cache"), "--fetch-retries=0", "--fetch-timeout=60000", "--maxsockets=1"];
function run(label, executable, args, cwd = repo, allowed = [0], timeout = 120000) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=512" } });
  const record = { label, executable, args, code: result.status, signal: result.signal, error: result.error?.code ?? null,
    stdoutSha256: hash(result.stdout || ""), stderrSha256: hash(result.stderr || "") };
  commands.push(record);
  writeFileSync(join(output, "commands.json"), JSON.stringify(commands, null, 2) + "\n");
  writeFileSync(join(work, label + ".stdout"), result.stdout || "");
  writeFileSync(join(work, label + ".stderr"), result.stderr || "");
  assert(!result.error && result.signal === null && allowed.includes(result.status), `${label} failed: ${JSON.stringify(record)}\n${result.stderr}`);
  return result;
}
const save = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2) + "\n");
const baselineBytes = path => run("read-base-" + path.replaceAll("/", "-"), "git", ["show", BASE + ":" + path]).stdout;
const targets = { "postcss-selector-parser": "7.1.6", "source-map-js": "1.2.2" };
const fixturePath = "scripts/dependency-review/consumer-fixture";
try {
  assert.equal(Number(process.versions.node.split(".")[0]), 22);
  const npmVersion = run("npm-version", "npm", ["--version"]).stdout.trim();
  assert.equal(Number(npmVersion.split(".")[0]), 11);
  assert.equal(run("verify-base-tree", "git", ["rev-parse", BASE + "^{tree}"]).stdout.trim(), TREE);
  const published = {};
  for (const [name, version] of Object.entries(targets)) {
    const metadata = JSON.parse(run("registry-" + name, "npm", ["view", `${name}@${version}`, "--json", ...npmOptions]).stdout);
    assert.equal(metadata.name, name); assert.equal(metadata.version, version);
    assert.equal(metadata.dist?.tarball, `${registry}/${name}/-/${name}-${version}.tgz`);
    assert.match(metadata.dist?.integrity || "", /^sha512-[A-Za-z0-9+/]+=*$/);
    assert.deepEqual(metadata.dependencies || {}, name === "source-map-js" ? {} : { cssesc: "^3.0.0", "util-deprecate": "^1.0.2" });
    assert.equal(metadata.license, name === "source-map-js" ? "BSD-3-Clause" : "MIT");
    const packed = JSON.parse(run("pack-" + name, "npm", ["pack", `${name}@${version}`, "--ignore-scripts", "--json", "--pack-destination=" + work, ...npmOptions]).stdout);
    assert.equal(packed.length, 1); assert.equal(packed[0].name, name); assert.equal(packed[0].version, version);
    assert.match(packed[0].filename, /^[a-z0-9.-]+\.tgz$/);
    const bytes = readFileSync(join(work, packed[0].filename));
    const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
    assert.equal(integrity, metadata.dist.integrity); assert.equal(packed[0].integrity, integrity);
    published[name] = { ...metadata, verifiedArchiveSha256: hash(bytes), verifiedArchiveBytes: bytes.length };
    save(`registry-${name}-${version}.json`, published[name]);
  }
  // Pin the independently observed Dependabot version/integrity, not an alias or
  // an unreviewed newer resolution returned by a registry.
  assert.equal(published["source-map-js"].dist.integrity, "sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==");
  // Official registry metadata and packed bytes independently preserved by
  // generation run 37401926790; refuse a changed published parser artifact.
  assert.equal(published["postcss-selector-parser"].dist.integrity, "sha512-7qASPzhKF2l2KLboRZux8CCTRMdGiV08vWmyKzPz22qZ7ZjQBOeY7rNzNoCLSUiftJ7HUq0GERHmxw/t0dCdMw==");
  const baseline = {};
  for (const kind of ["root", "consumer"]) {
    const prefix = kind === "root" ? "" : fixturePath + "/";
    const manifestBytes = baselineBytes(prefix + "package.json");
    const lockBytes = baselineBytes(prefix + "package-lock.json");
    const originalManifest = JSON.parse(manifestBytes);
    const originalLock = JSON.parse(lockBytes);
    const manifest = json(join(repo, prefix, "package.json"));
    validateReviewedOverrides(manifest);
    const withoutOverrides = structuredClone(manifest); delete withoutOverrides.overrides;
    const expectedManifest = structuredClone(originalManifest);
    if (kind === "root") expectedManifest.devDependencies.tailwindcss = "3.4.19";
    assert.deepEqual(withoutOverrides, expectedManifest, "Only the reviewed overrides and already-locked Tailwind pin may change the manifest");
    const directory = join(work, kind + "-candidate"); mkdirSync(directory);
    writeFileSync(join(directory, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(directory, "package-lock.json"), lockBytes);
    if (kind === "root") {
      mkdirSync(join(directory, "vendor"));
      copyFileSync(join(repo, "vendor/braces-3.0.3-local.tgz"), join(directory, "vendor/braces-3.0.3-local.tgz"));
    } else copyFileSync(join(repo, "vendor/braces-3.0.3-local.tgz"), join(directory, "braces-local-candidate.tgz"));
    // npm owns generation. Never synthesize resolved URLs, dependencies, SRI or
    // package inventory. Any unrelated update is rejected immediately below.
    run(kind + "-generate-lock", "npm", ["update", "source-map-js", "--package-lock-only", "--ignore-scripts", "--no-fund", "--audit=true", ...npmOptions], directory);
    assert.deepEqual(json(join(directory, "package.json")), manifest, "npm changed the requested manifest");
    const generated = json(join(directory, "package-lock.json"));
    assert.deepEqual(Object.keys(generated.packages).sort(), Object.keys(originalLock.packages).sort(), "Unrelated package inventory drift");
    for (const [location, previous] of Object.entries(originalLock.packages)) {
      const name = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
      const next = generated.packages[location];
      if (location === "" && kind === "root") {
        const expectedRoot = structuredClone(previous);
        expectedRoot.devDependencies.tailwindcss = "3.4.19";
        assert.deepEqual(next, expectedRoot, "Unrelated root lock declaration drift");
      } else if (!Object.hasOwn(targets, name)) assert.deepEqual(next, previous, "Unrelated lock drift: " + location);
      else {
        const metadata = published[name];
        assert.equal(next.version, targets[name]); assert.equal(next.resolved, metadata.dist.tarball); assert.equal(next.integrity, metadata.dist.integrity);
        assert.deepEqual(next.dependencies || {}, metadata.dependencies || {});
        assert.deepEqual(next.engines || {}, metadata.engines || {});
        assert.equal(next.license, metadata.license); assert.equal(next.dev, previous.dev);
        assert.equal(next.optional, previous.optional); assert.equal(next.hasInstallScript, previous.hasInstallScript);
      }
    }
    copyFileSync(join(directory, "package-lock.json"), join(output, kind + "-package-lock.json"));
    baseline[kind] = { directory, originalManifest, originalLock, manifestBytes, lockBytes,
      originalLockSha256: hash(lockBytes), generatedLockSha256: hash(readFileSync(join(directory, "package-lock.json"))) };
  }
  for (const production of [false, true]) {
    const label = production ? "candidate-production-audit" : "candidate-full-audit";
    const result = run(label, "npm", ["audit", "--json", "--audit-level=moderate", ...(production ? ["--omit=dev"] : ["--include=dev", "--include=optional", "--include=peer"]), ...npmOptions], baseline.root.directory, [0, 1]);
    writeFileSync(join(output, label + ".json"), result.stdout); writeFileSync(join(output, label + ".stderr.txt"), result.stderr);
    const evidence = { report: JSON.parse(result.stdout), code: result.status, signal: result.signal, error: result.error };
    if (production) validateAuditProcess(evidence, true); else validateScopedAudit(evidence);
  }
  const baselineConsumer = join(work, "consumer-baseline"); mkdirSync(baselineConsumer);
  writeFileSync(join(baselineConsumer, "package.json"), baseline.consumer.manifestBytes);
  writeFileSync(join(baselineConsumer, "package-lock.json"), baseline.consumer.lockBytes);
  copyFileSync(join(repo, "vendor/braces-3.0.3-local.tgz"), join(baselineConsumer, "braces-local-candidate.tgz"));
  for (const [mode, directory] of [["baseline", baselineConsumer], ["candidate", baseline.consumer.directory]]) {
    const before = hash(readFileSync(join(directory, "package-lock.json")));
    run(mode + "-consumer-ci", "npm", ["ci", "--ignore-scripts", "--no-fund", "--audit=true", ...npmOptions], directory);
    assert.equal(hash(readFileSync(join(directory, "package-lock.json"))), before, "npm ci mutated locked evidence");
    for (const [name, version] of Object.entries(targets)) {
      const pkg = json(join(directory, "node_modules", name, "package.json"));
      const expected = mode === "candidate" ? version : (name === "source-map-js" ? "1.2.1" : "6.1.4");
      assert.equal(pkg.version, expected);
      if (mode === "candidate") assert.deepEqual(pkg.dependencies || {}, published[name].dependencies || {});
    }
    run(mode + "-compatibility", process.execPath, ["--max-old-space-size=512", join(repo, "scripts/dependency-review/parser-compatibility-worker.mjs"), directory, mode, output], repo, [0], 90000);
    const braces = run(mode + "-braces-consumer", process.execPath, ["--max-old-space-size=192", join(repo, "scripts/dependency-review/braces-consumer-worker.mjs"), directory, "candidate"], repo, [0], 30000);
    writeFileSync(join(output, mode + "-braces-consumer.json"), braces.stdout);
  }
  const before = json(join(output, "baseline-compatibility.json"));
  const after = json(join(output, "candidate-compatibility.json"));
  for (const key of ["appCss", "nestedCss", "roundTrips", "transformed", "sourceMapBehavior"]) assert.deepEqual(after[key], before[key], "Consumer behavior differs: " + key);
  assert.equal(readFileSync(join(output, "baseline-app.css"), "utf8"), readFileSync(join(output, "candidate-app.css"), "utf8"));
  assert.equal(readFileSync(join(output, "baseline-nested.css"), "utf8"), readFileSync(join(output, "candidate-nested.css"), "utf8"));
  const beforeBraces = json(join(output, "baseline-braces-consumer.json"));
  const afterBraces = json(join(output, "candidate-braces-consumer.json"));
  assert.deepEqual(afterBraces.globResults, beforeBraces.globResults); assert.deepEqual(afterBraces.css, beforeBraces.css);
  save("generation-proof.json", { status: "isolated lock generation and compatibility passed; not release CI", baseCommit: BASE, baseTree: TREE,
    sourceCommit: run("source-commit", "git", ["rev-parse", "HEAD"]).stdout.trim(), node: process.version, npm: npmVersion,
    overrides: REVIEWED_OVERRIDES, targets, locks: Object.fromEntries(Object.entries(baseline).map(([key, value]) => [key, { originalSha256: value.originalLockSha256, generatedSha256: value.generatedLockSha256 }])),
    appCss: after.appCss, nestedCss: after.nestedCss, comparedSelectors: after.roundTrips.length,
    preservedBracesConsumerChains: afterBraces.installedConsumerPaths.map(entry => entry.chain),
    limitations: ["No full root installation or application build", "No PostgreSQL, HTTP/browser, Railway or Production proof", "Fresh full release gate and independent review remain mandatory"] });
  console.log("Isolated lock and CSS compatibility evidence complete: " + output);
} catch (error) {
  save("failure.json", { status: "failed; no release conclusion", message: error.message });
  console.error(error); process.exitCode = 1;
}

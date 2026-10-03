#!/usr/bin/env node
// Manual, isolated evidence harness. This is not a release gate, disposition
// exception or application installation. Run only in a coordinated quiet slot.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractOfficialBracesFixture } from "./braces-fixture.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directory = fileURLToPath(new URL("./", import.meta.url));
const contract = JSON.parse(readFileSync(join(directory, "braces-review-contract.json"), "utf8"));
const provenance = JSON.parse(readFileSync(join(repository, "vendor/braces-provenance.json"), "utf8"));
const workspace = mkdtempSync(join(tmpdir(), "aqlan-braces-review-"));
const consumer = join(workspace, "consumer");
mkdirSync(consumer);
const json = path => JSON.parse(readFileSync(path, "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sri = bytes => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const npmArgs = ["--registry=" + contract.registry, "--cache=" + join(workspace, "npm-cache"),
  "--maxsockets=1", "--fetch-timeout=" + contract.commandTimeoutMs, "--fetch-retries=0"];
const commandResults = [];

function run(label, executable, args, { cwd = workspace, timeout = contract.commandTimeoutMs, allowed = [0] } = {}) {
  const result = spawnSync(executable, args, {
    cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=" + contract.maxOldSpaceMiB].filter(Boolean).join(" ") },
  });
  writeFileSync(join(workspace, label + ".stdout"), result.stdout || "");
  writeFileSync(join(workspace, label + ".stderr"), result.stderr || "");
  commandResults.push({ label, executable, args, status: result.status, signal: result.signal, error: result.error?.code || null });
  if (result.error || result.signal || !allowed.includes(result.status)) {
    throw new Error(`${label} failed (status ${result.status}, signal ${result.signal}, error ${result.error?.code || "none"}); see retained logs`);
  }
  return result;
}

function validateAudit(report, requireOriginalAdvisory = true) {
  assert.equal(report.auditReportVersion, 2);
  assert(report.vulnerabilities && typeof report.vulnerabilities === "object" && !Array.isArray(report.vulnerabilities));
  assert(report.metadata?.vulnerabilities && !report.error, "Missing/error audit evidence must fail this proof");
  for (const field of ["info", "low", "moderate", "high", "critical", "total"]) {
    assert(Number.isInteger(report.metadata.vulnerabilities[field]) && report.metadata.vulnerabilities[field] >= 0);
  }
  if (requireOriginalAdvisory) {
    assert(report.vulnerabilities.braces?.via?.some(advisory =>
      typeof advisory === "object" && advisory.url === provenance.patch.advisory),
    "Expected original advisory discovery; a changed registry result requires review");
  }
}

try {
  assert.equal(Number(process.versions.node.split(".")[0]), contract.nodeMajor, "Use supported Node 22");
  const npmVersion = run("npm-version", "npm", ["--version"], { timeout: 10_000 }).stdout.trim();
  assert.equal(Number(npmVersion.split(".")[0]), contract.npmMajor, "Use npm 11 bulk audit support");
  const official = extractOfficialBracesFixture();
  const fixtureEvidence = { integrity: official.integrity, hashes: official.hashes };
  official.cleanup();
  for (const [name, expected] of Object.entries(provenance.patch.source_sha256)) {
    assert.equal(sha256(readFileSync(join(repository, "vendor/braces", name))), expected, `Candidate drift: ${name}`);
  }

  for (const name of ["package.json", "package-lock.json"]) {
    copyFileSync(join(directory, "consumer-fixture", name), join(consumer, name));
  }
  const consumerLock = json(join(consumer, "package-lock.json"));
  const pack = JSON.parse(run("pack-candidate", "npm", ["pack", join(repository, "vendor/braces"),
    "--ignore-scripts", "--json", "--pack-destination=" + workspace, ...npmArgs]).stdout)[0];
  assert.equal(pack.name, "braces");
  assert.equal(pack.version, "3.0.3");
  const packedBytes = readFileSync(join(workspace, pack.filename));
  assert.equal(sri(packedBytes), consumerLock.packages["node_modules/braces"].integrity,
    "Candidate archive differs from committed consumer lock; review/relock explicitly");
  copyFileSync(join(workspace, pack.filename), join(consumer, "braces-local-candidate.tgz"));
  const lockBefore = sha256(readFileSync(join(consumer, "package-lock.json")));
  run("consumer-ci", "npm", ["ci", "--ignore-scripts", "--audit=true", "--no-fund", ...npmArgs], { cwd: consumer });
  assert.equal(sha256(readFileSync(join(consumer, "package-lock.json"))), lockBefore, "npm ci changed the committed consumer lock");

  const results = {};
  for (const mode of ["official", "candidate"]) {
    results[mode] = JSON.parse(run("consumer-" + mode, process.execPath,
      ["--max-old-space-size=" + contract.maxOldSpaceMiB, join(directory, "braces-consumer-worker.mjs"), consumer, mode],
      { timeout: contract.workerTimeoutMs }).stdout);
  }
  assert.deepEqual(results.candidate.globResults, results.official.globResults);
  assert.equal(readFileSync(join(consumer, "candidate.css"), "utf8"), readFileSync(join(consumer, "official.css"), "utf8"));

  const rawAudits = {};
  for (const mode of ["original", "candidate"]) {
    const auditDirectory = join(workspace, "full-audit-" + mode);
    mkdirSync(auditDirectory);
    const manifest = json(join(repository, "package.json"));
    const lock = json(join(repository, "package-lock.json"));
    // Both scratch graphs use the same explicit development-only dependency.
    // The original graph points at the official registry package; candidate
    // differs only by the local artifact spec and its integrity.
    manifest.devDependencies.braces = "3.0.3";
    lock.packages[""].devDependencies.braces = "3.0.3";
    lock.packages["node_modules/braces"].resolved = provenance.upstream.tarball;
    lock.packages["node_modules/braces"].integrity = provenance.upstream.integrity;
    const officialLock = structuredClone(lock);
    if (mode === "candidate") {
      manifest.devDependencies.braces = "file:braces-local-candidate.tgz";
      copyFileSync(join(workspace, pack.filename), join(auditDirectory, "braces-local-candidate.tgz"));
    }
    writeFileSync(join(auditDirectory, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(auditDirectory, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
    if (mode === "candidate") {
      run("full-audit-candidate-lock", "npm", ["install", "--package-lock-only", "--ignore-scripts", "--audit=true", ...npmArgs], { cwd: auditDirectory });
      const before = officialLock.packages;
      const after = json(join(auditDirectory, "package-lock.json")).packages;
      assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "Unexpected package inventory change");
      for (const name of Object.keys(before)) {
        if (name === "node_modules/braces") {
          const { resolved: oldUrl, integrity: oldIntegrity, ...oldPackage } = before[name];
          const { resolved: newUrl, integrity: newIntegrity, ...newPackage } = after[name];
          assert.deepEqual(newPackage, oldPackage);
          assert.equal(newIntegrity, sri(packedBytes));
          assert.equal(oldIntegrity, provenance.upstream.integrity);
          assert(oldUrl.startsWith(contract.registry + "/") && newUrl.startsWith("file:"));
        } else if (name === "") {
          const expected = structuredClone(before[name]);
          expected.devDependencies.braces = "file:braces-local-candidate.tgz";
          assert.deepEqual(after[name], expected, "Unrelated root lockfile change");
        } else assert.deepEqual(after[name], before[name], `Unrelated lockfile change: ${name}`);
      }
    }
    const audit = run("raw-full-audit-" + mode, "npm", ["audit", "--audit=true", "--json", "--include=dev", "--include=optional", "--include=peer", ...npmArgs],
      { cwd: auditDirectory, allowed: [0, 1] });
    rawAudits[mode] = JSON.parse(audit.stdout);
    validateAudit(rawAudits[mode]);
  }
  assert.deepEqual(rawAudits.candidate, rawAudits.original, "Raw registry discovery changed; do not infer an exception");
  const productionAudit = JSON.parse(run("raw-production-audit", "npm", ["audit", "--omit=dev", "--audit=true", "--json", ...npmArgs],
    { cwd: join(workspace, "full-audit-candidate"), allowed: [0, 1] }).stdout);
  validateAudit(productionAudit, false);
  for (const severity of ["moderate", "high", "critical"]) assert.equal(productionAudit.metadata.vulnerabilities[severity], 0);
  const result = {
    status: "Focused consumer proof passed; raw full audit remains blocking; no release disposition implemented",
    verifiedAtUtc: new Date().toISOString(), node: process.version, npm: npmVersion,
    contract, independentOfficialFixture: fixtureEvidence,
    consumerManifestSha256: sha256(readFileSync(join(consumer, "package.json"))),
    consumerLockSha256: lockBefore, candidateTarballIntegrity: sri(packedBytes),
    official: results.official, candidate: results.candidate, rawAudits, productionAudit,
    limitations: ["No full application install/build/typecheck/lint/PostgreSQL/browser verification", "Earlier full 403-package npm ci exited137 and remains unverified", "This harness does not modify scanner policy, app manifests or Production"],
  };
  writeFileSync(join(workspace, "result.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(workspace, "commands.json"), JSON.stringify(commandResults, null, 2) + "\n");
  console.log(JSON.stringify({ status: result.status, evidence: join(workspace, "result.json"), workspace }, null, 2));
} catch (error) {
  writeFileSync(join(workspace, "commands.json"), JSON.stringify(commandResults, null, 2) + "\n");
  console.error(JSON.stringify({ status: "Proof failed; no release conclusion", error: error.message, workspace }));
  process.exitCode = 1;
}

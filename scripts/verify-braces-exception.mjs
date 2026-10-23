#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRACES_EXCEPTION as PIN } from "../lib/braces-exception-pins.mjs";
import { classifyFullAudit, invariant, isRecord, validateOfficialEvidence, validateScopedAudit, validateAuditProcess, validateWithdrawnDisposition, validateWithdrawnOfficialEvidence } from "../lib/scoped-braces-exception.mjs";
import { inspectInstalledBraces, sha256 } from "./dependency-security/installed-braces.mjs";

import { runAuditJson, preserveRawAudit } from "./dependency-security/audit-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function fetchOfficialJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Cache-Control": "no-cache", "User-Agent": "aqlan-scoped-braces-verifier" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
  invariant(response.ok && response.url === url, `official lookup failed: ${url}`);
  invariant(!/rel="next"/.test(response.headers.get("link") ?? ""), "official advisory result pagination unexpected");
  invariant(/json/.test(response.headers.get("content-type") ?? ""), "official endpoint returned non-JSON");
  const length = response.headers.get("content-length");
  invariant(length === null || Number(length) <= 4 * 1024 * 1024, "official response too large");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("Official response exceeded limit"); }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Taken BEFORE both audits run; verification requires the installation to be byte-identical afterwards. */
export async function snapshotInstallation(projectRoot = root, inspect = inspectInstalledBraces) {
  return inspect(projectRoot);
}

export async function verifyBracesException(fullRun, productionRun, projectRoot = root,
  { fetchJson = fetchOfficialJson, inspect = inspectInstalledBraces, installedBefore } = {}) {
  // "active": the reviewed advisory is still reported (scoped graph). "withdrawn": the full audit is
  // completely clean and live official proof of the withdrawal is compulsory below. Nothing else passes.
  const mode = classifyFullAudit(fullRun);
  validateAuditProcess(productionRun, true);
  const installed = await inspect(projectRoot);
  // Both audits must describe this exact installation: the caller inspects it BEFORE running them.
  invariant(isRecord(installedBefore) && ["installedTreeSha256", "lockSha256", "packageSha256"].every((key) => typeof installed[key] === "string" && installed[key] === installedBefore[key]),
    "installation changed between the audits and their verification");
  const disposition = mode === "active" ? validateScopedAudit(fullRun, installed) : validateWithdrawnDisposition(fullRun, installed);
  invariant(fullRun.report.metadata.dependencies.total === installed.lockPackageCount
    && productionRun.report.metadata.dependencies.total === installed.lockPackageCount, "audit dependency total differs from complete lock graph");
  const advisory = await fetchJson(`https://api.github.com/advisories/${PIN.ghsa}`);
  const matching = await fetchJson("https://api.github.com/advisories?ecosystem=npm&affects=braces%403.0.3&per_page=100");
  const registry = await fetchJson("https://registry.npmjs.org/braces");
  const official = mode === "active" ? validateOfficialEvidence(advisory, matching, registry) : validateWithdrawnOfficialEvidence(advisory, matching, registry);
  const proof = {
    format: mode === "active" ? "aqlan-scoped-braces-exception-v1" : "aqlan-braces-advisory-withdrawn-v1", mode, ...disposition, official,
    rawFullAuditSha256: sha256(fullRun.stdout), rawProductionAuditSha256: sha256(productionRun.stdout),
    lockSha256: installed.lockSha256, packageSha256: installed.packageSha256,
    installedTreeSha256: installed.installedTreeSha256,
    patchSha256: PIN.patchSha256, provenanceSha256: PIN.provenanceSha256,
    installedCopies: installed.bracesPaths.map((location) => ({ path: location, name: PIN.package, version: PIN.version, files: PIN.files })),
    consumerResolutions: installed.consumers, runtimeDependencyPaths: installed.runtimePaths,
    runtimeArtifactProof: "Required separately after BOTH production builds; this proof alone is insufficient for release",
  };
  await mkdir(path.join(projectRoot, ".dependency-audit"), { recursive: true });
  await writeFile(path.join(projectRoot, ".dependency-audit/exception-proof.json"), JSON.stringify(proof, null, 2) + "\n");
  return proof;
}

// Standalone verification captures real subprocess outcomes itself; no synthesized
// success/status flags and no offline/skip switches are accepted.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    invariant(process.argv.length === 2, "standalone verifier accepts no flags");
    const installedBefore = await snapshotInstallation();
    const full = runAuditJson();
    await preserveRawAudit(full, false, 1);
    const production = runAuditJson(true);
    await preserveRawAudit(production, true, 1);
    const proof = await verifyBracesException(full, production, root, { installedBefore });
    console.log(proof.mode === "active"
      ? `Verified only ${proof.advisory} on ${proof.installedCopies.length} patched installed copy/copies; raw findings remain ${JSON.stringify(proof.counts)}.`
      : `${proof.advisory} is officially withdrawn (${proof.official.withdrawnAt}); audits are completely clean and ${proof.installedCopies.length} patched installed copy/copies remain verified.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

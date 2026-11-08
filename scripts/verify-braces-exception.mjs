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
  // At most two waits (each <= 5s) and three separately time-bounded requests.
  // Only explicit gateway failures retry; content and security failures never do.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Cache-Control": "no-cache", "User-Agent": "aqlan-scoped-braces-verifier" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      // Do not log arbitrary exception messages/causes: transports may include
      // response bodies, credentials or redirect destinations in their errors.
      const codes = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]);
      const code = codes.has(error?.cause?.code) ? error.cause.code : codes.has(error?.code) ? error.code : "unclassified";
      const kind = error?.name === "TimeoutError" ? "timeout" : error?.name === "AbortError" ? "aborted" : "transport failure";
      invariant(false, `official lookup failed: ${url}; ${kind}; code=${code}`);
    }
    // Preserve exact-URL and HTTP checks, but distinguish them. Only bounded,
    // numeric public rate-limit diagnostics are safe to print, never raw headers
    // or an error body. No retry/fallback is inferred from an opaque HTTP failure.
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : "unknown";
    const numericHeader = (name) => {
      const value = response.headers?.get(name);
      return typeof value === "string" && /^\d{1,12}$/.test(value) ? value : "unavailable";
    };
    invariant(response.url === url, `official lookup failed: ${url}; response URL mismatch; HTTP ${status}`);
    if (!response.ok && [502, 503, 504].includes(status) && attempt < 3) {
      const retryAfter = response.headers.get("retry-after");
      // Support delta-seconds only. HTTP dates/ambiguous values cannot establish a
      // bounded wait without clock assumptions; reject them rather than retry early.
      invariant(retryAfter === null || /^[0-5]$/.test(retryAfter),
        `official lookup failed: ${url}; HTTP ${status}; Retry-After timing unsupported or exceeds 5s budget`);
      const delay = Math.max(attempt * 1000, retryAfter === null ? 0 : Number(retryAfter) * 1000);
      // Discard error content without parsing/logging it before another request.
      try { await response.body?.cancel(); } catch {
        invariant(false, `official lookup failed: ${url}; HTTP ${status}; error body cancellation failed`);
      }
      console.warn(`Official lookup HTTP ${status}: ${url}; retry ${attempt + 1}/3 after ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    invariant(response.ok, `official lookup failed: ${url}; HTTP ${status}; rate-limit-remaining=${numericHeader("x-ratelimit-remaining")}; rate-limit-reset=${numericHeader("x-ratelimit-reset")}; retry-after-seconds=${numericHeader("retry-after")}`);
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
}

/** Taken BEFORE both audits run; verification requires the installation to be byte-identical afterwards. */
export async function snapshotInstallation(projectRoot = root, inspect = inspectInstalledBraces) {
  return inspect(projectRoot);
}

export async function verifyBracesException(fullRun, productionRun, projectRoot = root,
  { fetchJson = fetchOfficialJson, inspect = inspectInstalledBraces, installedBefore, clock = Date.now } = {}) {
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
  const official = mode === "active" ? validateOfficialEvidence(advisory, matching, registry) : validateWithdrawnOfficialEvidence(advisory, matching, registry, clock());
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

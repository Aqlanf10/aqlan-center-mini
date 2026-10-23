#!/usr/bin/env node
/**
 * Full raw audit remains visible and unchanged. The temporary disposition applies
 * ONLY after complete graph, installed-copy, runtime graph and fresh official
 * evidence verification. After the official withdrawal of the reviewed advisory,
 * only a completely clean audit plus live official withdrawal proof passes. No advisory count is subtracted; every other finding
 * (including low) blocks while this narrowly scoped exception exists.
 */
import { decideAuditOutcome, describeBlockingVulnerabilities } from "../lib/ci-audit.ts";
import { classifyFullAudit, invariant, isInstant, isRecord, validateAuditProcess } from "../lib/scoped-braces-exception.mjs";
import { snapshotInstallation, verifyBracesException } from "./verify-braces-exception.mjs";
import { runAuditJson, preserveRawAudit } from "./dependency-security/audit-process.mjs";

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 15_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function auditedRun(production) {
  let lastError = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const run = runAuditJson(production);
    await preserveRawAudit(run, production, attempt);
    try {
      // Full audit: the reviewed scoped graph ("active") or, after the official withdrawal, a completely
      // clean report ("withdrawn"; live official proof is then compulsory). Anything else retries/fails.
      if (production) validateAuditProcess(run, true);
      else classifyFullAudit(run);
      return run;
    } catch (error) {
      lastError = error.message;
      // Confirmed threshold findings never become an outage fallback. A valid
      // known graph is the ONLY route into the independent verifier above.
      if (decideAuditOutcome(run.report) === "fail") {
        console.error(`بوابة التدقيق حمراء: ${describeBlockingVulnerabilities(run.report)}. ${lastError}`);
        return null;
      }
      console.warn(`[محاولة ${attempt}/${ATTEMPTS}] لم يكتمل التدقيق أو كان التقرير غير صالح: ${lastError}`);
      if (attempt < ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  console.error(`بوابة التدقيق مرفوضة بعد ${ATTEMPTS} محاولات: ${lastError}`);
  return null;
}

/** Only the two supported lifecycle states, with their required fields, are reported as success. */
function validateProofShape(proof) {
  invariant(isRecord(proof) && (proof.mode === "active" || proof.mode === "withdrawn"), `unknown verification mode ${String(proof?.mode)}`);
  invariant(["advisory", "cve", "package", "version"].every((key) => typeof proof[key] === "string" && proof[key].length > 0),
    "verification proof is missing required fields");
  const levels = ["info", "low", "moderate", "high", "critical"];
  const counts = proof.counts;
  invariant(isRecord(counts) && Object.keys(counts).sort().join() === [...levels, "total"].sort().join()
    && [...levels, "total"].every((key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    && counts.total === levels.reduce((sum, key) => sum + counts[key], 0), "verification proof counts are malformed");
  if (proof.mode === "withdrawn") {
    invariant(isRecord(proof.official) && isInstant(proof.official.withdrawnAt) && counts.total === 0, "withdrawn verification proof is malformed");
  }
  return proof;
}

async function main() {
  try {
    // Bind the audit evidence to this unchanged installation (re-compared inside the verifier).
    const installedBefore = await snapshotInstallation();
    const full = await auditedRun(false);
    if (!full) return 1;
    const production = await auditedRun(true);
    if (!production) return 1;
    const proof = validateProofShape(await verifyBracesException(full, production, undefined, { installedBefore }));
    if (proof.mode === "active") {
      console.log(`Scoped exception verified ONLY for ${proof.advisory} / ${proof.cve}, ${proof.package}@${proof.version}.`);
      console.log(`RAW full npm audit remains unchanged: ${JSON.stringify(proof.counts)}. Production-only audit has zero moderate+ findings. Post-build runtime proof remains mandatory.`);
    } else {
      console.log(`Advisory ${proof.advisory} / ${proof.cve} is officially withdrawn (${proof.official.withdrawnAt}); the scoped exception authorizes nothing.`);
      console.log(`RAW full and production npm audits are completely clean: ${JSON.stringify(proof.counts)}. The patched local ${proof.package}@${proof.version} copies were re-verified; post-build runtime proof remains mandatory.`);
    }
    return 0;
  } catch (error) {
    console.error(`بوابة التدقيق مرفوضة: ${error.message}`);
    return 1;
  }
}
process.exit(await main());

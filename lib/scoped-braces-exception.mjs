import { BRACES_EXCEPTION as PIN } from "./braces-exception-pins.mjs";

export function invariant(condition, message) {
  if (!condition) throw new Error(`BRACES_EXCEPTION_REJECTED: ${message}`);
}
export const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const equal = (left, right) => canonical(left) === canonical(right);
const levels = ["info", "low", "moderate", "high", "critical"];
const keysAre = (value, keys) => isRecord(value) && equal(Object.keys(value).sort(), [...keys].sort());
const strings = (value, nonempty = false) => Array.isArray(value) && (!nonempty || value.length > 0)
  && value.every((item) => typeof item === "string" && item.length > 0)
  && new Set(value).size === value.length;
export function packagePath(value) {
  return typeof value === "string" && /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(value)
    && !value.split("/").some((part) => part === "." || part === ".." || part.includes("\\"));
}

/** Validate the original registry report; never rewrite counts or remove nodes. */
export function validateAuditReport(report) {
  invariant(isRecord(report) && report.auditReportVersion === 2 && !Object.hasOwn(report, "error"), "incomplete audit report");
  invariant(isRecord(report.metadata) && isRecord(report.vulnerabilities), "missing audit graph/metadata");
  const counts = report.metadata.vulnerabilities;
  invariant(keysAre(counts, [...levels, "total"]), "unknown or missing vulnerability counters");
  const observed = Object.fromEntries([...levels, "total"].map((level) => [level, 0]));
  for (const level of [...levels, "total"]) invariant(Number.isSafeInteger(counts[level]) && counts[level] >= 0, "invalid vulnerability counter");
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
    invariant(keysAre(vulnerability, ["name", "severity", "isDirect", "via", "effects", "range", "nodes", "fixAvailable"]), `unknown/incomplete graph node ${name}`);
    invariant(vulnerability.name === name && levels.includes(vulnerability.severity) && typeof vulnerability.isDirect === "boolean", `invalid node identity ${name}`);
    invariant(typeof vulnerability.range === "string" && vulnerability.range.length > 0, `invalid node range ${name}`);
    invariant(strings(vulnerability.nodes, true) && vulnerability.nodes.every(packagePath), `invalid installed paths ${name}`);
    invariant(strings(vulnerability.effects) && Array.isArray(vulnerability.via) && vulnerability.via.length > 0, `missing causes ${name}`);
    invariant(new Set(vulnerability.via.map(canonical)).size === vulnerability.via.length, `duplicate advisory causes ${name}`);
    const fix = vulnerability.fixAvailable;
    invariant(typeof fix === "boolean" || (keysAre(fix, ["name", "version", "isSemVerMajor"]) && typeof fix.name === "string" && typeof fix.version === "string" && typeof fix.isSemVerMajor === "boolean"), `invalid fix metadata ${name}`);
    observed[vulnerability.severity] += 1;
    observed.total += 1;
  }
  invariant(equal(counts, observed), "audit counters contradict complete graph");
  const dependencies = report.metadata.dependencies;
  invariant(keysAre(dependencies, ["prod", "dev", "optional", "peer", "peerOptional", "total"]), "missing dependency counters");
  for (const value of Object.values(dependencies)) invariant(Number.isSafeInteger(value) && value >= 0, "invalid dependency counter");
  const affectedPaths = new Set(Object.values(report.vulnerabilities).flatMap((node) => node.nodes));
  invariant(dependencies.total >= affectedPaths.size, "dependency total smaller than affected installed paths");
  return report;
}

export function validateAuditProcess(run, production = false) {
  invariant(run.signal === null && run.error === undefined, "audit process error or signal");
  const report = validateAuditReport(run.report);
  const counts = report.metadata.vulnerabilities;
  const blocking = counts.moderate + counts.high + counts.critical;
  invariant(run.code === (blocking > 0 ? 1 : 0), "audit process status contradicts report");
  if (production) {
    invariant(blocking === 0, "production audit contains moderate+ finding");
    invariant(counts.total === 0, "additional production advisory is not authorized by the scoped exception");
  }
  return report;
}

/** Every cause must end exclusively at this one reviewed advisory. */
export function validateScopedAudit(run, installed) {
  const report = validateAuditProcess(run);
  const graph = report.vulnerabilities;
  invariant(Object.hasOwn(graph, PIN.package), "known advisory disappeared; remove/review the exception");
  const completed = new Set();
  const visiting = new Set();
  function visit(name) {
    invariant(Object.hasOwn(graph, name), `dangling advisory cause ${name}`);
    invariant(!visiting.has(name), `cyclic advisory graph ${name}`);
    if (completed.has(name)) return;
    visiting.add(name);
    const node = graph[name];
    invariant(node.severity === "high", `unexpected severity/advisory at ${name}`);
    for (const cause of node.via) {
      if (typeof cause === "string") {
        visit(cause);
        if (installed) for (const nodePath of node.nodes) {
          invariant(installed.edges[nodePath]?.some((edge) => edge.name === cause && graph[cause].nodes.includes(edge.path)), `cause does not resolve from installed ${nodePath} to ${cause}`);
        }
      } else {
        invariant(name === PIN.package && equal(cause, PIN.advisoryLeaf), `additional or changed advisory at ${name}`);
      }
    }
    for (const effect of node.effects) invariant(Object.hasOwn(graph, effect) && graph[effect].via.includes(name), `invalid advisory effect ${effect}`);
    if (installed) for (const nodePath of node.nodes) {
      invariant(installed.packages[nodePath]?.name === name, `audit path not installed: ${nodePath}`);
    }
    visiting.delete(name);
    completed.add(name);
  }
  for (const name of Object.keys(graph)) visit(name);
  invariant(graph.braces.via.length === 1 && isRecord(graph.braces.via[0]), "braces has additional advisory causes");
  if (installed) {
    invariant(equal([...graph.braces.nodes].sort(), [...installed.bracesPaths].sort()), "audit does not cover every installed braces copy");
    for (const path of installed.bracesPaths) invariant(installed.packages[path].version === PIN.version, "braces version changed");
  }
  return { advisory: PIN.ghsa, cve: PIN.cve, package: PIN.package, version: PIN.version, counts: report.metadata.vulnerabilities, auditedPackages: Object.keys(graph).sort() };
}

/** Live official evidence is compulsory for each gate invocation, not a background promise. */
export function validateOfficialEvidence(advisory, matchingAdvisories, registry) {
  invariant(isRecord(advisory) && advisory.ghsa_id === PIN.ghsa && advisory.cve_id === PIN.cve
    && advisory.html_url === PIN.advisoryLeaf.url && advisory.type === "reviewed" && advisory.severity === "high"
    && advisory.updated_at === PIN.advisoryUpdatedAt && advisory.withdrawn_at === null, "official advisory changed; remove/review exception");
  invariant(equal(Object.fromEntries(Object.keys(PIN.officialAdvisory).map((key) => [key, advisory[key]])), PIN.officialAdvisory), "official security-material advisory fields changed/malformed");
  invariant(equal(advisory.identifiers, [{ value: PIN.ghsa, type: "GHSA" }, { value: PIN.cve, type: "CVE" }]), "official advisory identifiers changed");
  invariant(Array.isArray(advisory.vulnerabilities) && advisory.vulnerabilities.length === 1, "official affected packages changed");
  const affected = advisory.vulnerabilities[0];
  invariant(equal(affected.package, { ecosystem: "npm", name: PIN.package }) && affected.vulnerable_version_range === PIN.officialRange
    && affected.first_patched_version === null && equal(affected.vulnerable_functions, []), "official range/fix changed; remove exception");
  invariant(Array.isArray(matchingAdvisories) && matchingAdvisories.length === 1
    && matchingAdvisories[0].ghsa_id === PIN.ghsa && matchingAdvisories[0].updated_at === PIN.advisoryUpdatedAt
    && equal(Object.fromEntries(Object.keys(PIN.officialAdvisory).map((key) => [key, matchingAdvisories[0][key]])), PIN.officialAdvisory), "new/missing/changed official advisory");
  validateOfficialRelease(registry);
  return { advisoryUpdatedAt: advisory.updated_at, officialVersion: PIN.version, checkedAt: new Date().toISOString() };
}

/** The official npm release the local patched copy was reviewed against: unchanged, in both lifecycle states. */
export function validateOfficialRelease(registry) {
  invariant(isRecord(registry) && registry.name === PIN.package && isRecord(registry.versions) && isRecord(registry["dist-tags"])
    && registry["dist-tags"].latest === PIN.version, "official release changed; remove/review exception");
  // Fail on ANY newly published version, including prereleases/backports, rather
  // than guessing whether it fixes this advisory. The reviewed list is separately pinned.
  invariant(equal(Object.keys(registry.versions).sort(), PIN.officialVersions), "official package versions changed; remove/review exception");
  const release = registry.versions[PIN.version];
  invariant(isRecord(release) && release.name === PIN.package && release.version === PIN.version
    && release.dist?.integrity === PIN.officialIntegrity && release.dist?.tarball === PIN.officialTarball, "official source artifact changed");
}

/*
 * Withdrawal lifecycle. GitHub withdrew GHSA-vfj7-8cjw-p6xm on 2026-10-23 («not a practically
 * exploitable vulnerability»), so npm audit stops reporting it and the scoped exception has nothing
 * left to authorize. That state is accepted ONLY as (1) a complete, fully clean full audit — no
 * finding of any level, valid counters and process status — and (2) compulsory live official proof
 * that this same advisory is withdrawn, that no other or still-active advisory affects the installed
 * braces version, and that the official release is unchanged. A missing, failed or malformed
 * response is never a clean audit. The local patched braces copy, its integrity pins, installed-copy,
 * consumer and runtime/dev-only checks are retained unchanged.
 */
const isInstant = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));

export function validateWithdrawnAudit(run) {
  const report = validateAuditProcess(run);
  invariant(Object.keys(report.vulnerabilities).length === 0 && report.metadata.vulnerabilities.total === 0,
    "audit is not completely clean; a withdrawn advisory authorizes no other finding");
  return report;
}

/** The reviewed lifecycle state of a complete full audit: "active" (scoped graph) or "withdrawn" (clean). */
export function classifyFullAudit(run) {
  try {
    validateScopedAudit(run);
    return "active";
  } catch (error) {
    if (!/known advisory disappeared/.test(error.message)) throw error;
    validateWithdrawnAudit(run);
    return "withdrawn";
  }
}

/** Installed-copy disposition for the withdrawn state: every installed braces copy is still the pinned patched one. */
export function validateWithdrawnDisposition(run, installed) {
  const report = validateWithdrawnAudit(run);
  invariant(isRecord(installed) && Array.isArray(installed.bracesPaths) && installed.bracesPaths.length > 0, "no installed patched braces copy");
  for (const path of installed.bracesPaths) invariant(installed.packages[path]?.version === PIN.version, "braces version changed");
  return { advisory: PIN.ghsa, cve: PIN.cve, package: PIN.package, version: PIN.version, counts: report.metadata.vulnerabilities, auditedPackages: [] };
}

export function validateWithdrawnOfficialEvidence(advisory, matchingAdvisories, registry, now = Date.now()) {
  invariant(isRecord(advisory) && advisory.ghsa_id === PIN.ghsa && advisory.cve_id === PIN.cve
    && advisory.html_url === PIN.advisoryLeaf.url, "official advisory identity changed");
  invariant(equal(advisory.identifiers, [{ value: PIN.ghsa, type: "GHSA" }, { value: PIN.cve, type: "CVE" }]), "official advisory identifiers changed");
  invariant(isInstant(advisory.withdrawn_at), "official advisory is not withdrawn; the scoped exception still applies");
  const withdrawnAt = Date.parse(advisory.withdrawn_at);
  invariant(withdrawnAt > Date.parse(PIN.advisoryUpdatedAt) && withdrawnAt <= now + 5 * 60_000, "official withdrawal time implausible");
  invariant(isInstant(advisory.updated_at) && Date.parse(advisory.updated_at) >= Date.parse(PIN.advisoryUpdatedAt), "official advisory update time malformed");
  invariant(Array.isArray(advisory.vulnerabilities) && advisory.vulnerabilities.length === 1, "official affected packages changed");
  const affected = advisory.vulnerabilities[0];
  invariant(isRecord(affected) && equal(affected.package, { ecosystem: "npm", name: PIN.package })
    && affected.vulnerable_version_range === PIN.officialRange && affected.first_patched_version === null, "official affected package/range changed");
  // The affects=braces@3.0.3 query still lists the withdrawn advisory, so an empty list is not required —
  // but every listed entry must be this same advisory with this same withdrawal instant.
  invariant(Array.isArray(matchingAdvisories) && matchingAdvisories.every((entry) => isRecord(entry) && entry.ghsa_id === PIN.ghsa && entry.withdrawn_at === advisory.withdrawn_at),
    "another or still-active official advisory affects the installed braces version");
  validateOfficialRelease(registry);
  return { withdrawnAt: advisory.withdrawn_at, advisoryUpdatedAt: advisory.updated_at, officialVersion: PIN.version, checkedAt: new Date(now).toISOString() };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { classifyFullAudit, validateOfficialEvidence, validateWithdrawnAudit, validateWithdrawnOfficialEvidence } from "../lib/scoped-braces-exception.mjs";
import { fetchOfficialJson, verifyBracesException } from "../scripts/verify-braces-exception.mjs";
import { inspectInstalledBraces } from "../scripts/dependency-security/installed-braces.mjs";
import { REVIEWED_OVERRIDES } from "../scripts/dependency-security/reviewed-overrides.mjs";
import { BRACES_EXCEPTION as PIN } from "../lib/braces-exception-pins.mjs";

/*
 * Withdrawal lifecycle of the scoped braces exception (GHSA-vfj7-8cjw-p6xm, withdrawn by GitHub on
 * 2026-10-23). A completely clean audit passes ONLY with compulsory live official proof of that same
 * advisory's withdrawal, no other/still-active advisory, an unchanged official release and the
 * unchanged patched local copy. Unavailable services, malformed payloads, any finding and any
 * patch/integrity/installed-copy drift stay fail-closed. The active scoped path is unchanged
 * (braces-scoped-audit.test.mjs).
 */
const fixtures = fileURLToPath(new URL("./fixtures/dependency-security/", import.meta.url));
const load = async (name) => JSON.parse(await readFile(path.join(fixtures, `${name}.json`), "utf8"));
const activeFull = await load("full-audit");
const cleanProduction = await load("production-audit");
const activeAdvisory = await load("advisory");
const registry = await load("registry");
const WITHDRAWN_AT = "2026-10-23T12:53:02Z";
const UPDATED_AT = "2026-10-23T12:53:05Z";
const NOW = Date.parse("2026-10-23T18:00:00Z");
const withdrawnAdvisory = () => ({ ...structuredClone(activeAdvisory), withdrawn_at: WITHDRAWN_AT, updated_at: UPDATED_AT });
/** The complete clean report npm audit now returns (same shape as the clean production fixture). */
const cleanReport = (dependencyTotal) => {
  const report = structuredClone(cleanProduction);
  if (dependencyTotal !== undefined) for (const key of Object.keys(report.metadata.dependencies)) report.metadata.dependencies[key] = key === "total" || key === "dev" ? dependencyTotal : 0;
  return report;
};
const run = (report, code = 0) => ({ report, code, signal: null, error: undefined, stdout: JSON.stringify(report), stderr: "" });

describe("full-audit lifecycle classification", () => {
  it("keeps the active scoped graph active and accepts a completely clean report only as withdrawn", () => {
    expect(classifyFullAudit(run(structuredClone(activeFull), 1))).toBe("active");
    expect(classifyFullAudit(run(cleanReport()))).toBe("withdrawn");
  });
  it.each([
    ["missing response (no report)", run(null)],
    ["registry error payload", run({ error: { code: "E503", summary: "Service Unavailable" } })],
    ["incomplete report", run({ auditReportVersion: 2, metadata: {} })],
    ["missing counters", (() => { const r = cleanReport(); delete r.metadata.vulnerabilities.total; return run(r); })()],
    ["counters contradicting the empty graph", (() => { const r = cleanReport(); r.metadata.vulnerabilities.high = 1; r.metadata.vulnerabilities.total = 1; return run(r, 1); })()],
    ["clean report with failing status", run(cleanReport(), 1)],
    ["a claimed zero summary over a non-empty graph", (() => { const r = cleanReport(); r.vulnerabilities.other = { ...structuredClone(activeFull.vulnerabilities.braces), name: "other", severity: "info", effects: [] }; return run(r); })()],
    ["a moderate finding with a passing status", (() => { const r = cleanReport(); r.vulnerabilities.other = { ...structuredClone(activeFull.vulnerabilities.braces), name: "other", severity: "moderate", effects: [] }; r.metadata.vulnerabilities.moderate = 1; r.metadata.vulnerabilities.total = 1; return run(r, 0); })()],
    ["a partial graph node", (() => { const r = cleanReport(); r.vulnerabilities.other = { name: "other", severity: "low" }; r.metadata.vulnerabilities.low = 1; r.metadata.vulnerabilities.total = 1; return run(r); })()],
    ["missing graph with zero counters", (() => { const r = cleanReport(); delete r.vulnerabilities; return run(r); })()],
    ["missing dependency counters", (() => { const r = cleanReport(); delete r.metadata.dependencies; return run(r); })()],
    ["spawn error", { ...run(cleanReport()), error: new Error("ECONNRESET") }],
    ["signal", { ...run(cleanReport()), signal: "SIGTERM" }],
  ])("rejects %s", (_label, input) => { expect(() => classifyFullAudit(input)).toThrow(/BRACES_EXCEPTION_REJECTED/); });
  it.each([["info", 0], ["low", 0], ["moderate", 1], ["high", 1], ["critical", 1]])("rejects an unexpected %s finding on any package", (severity, code) => {
    const report = cleanReport();
    report.vulnerabilities.other = { ...structuredClone(activeFull.vulnerabilities.braces), name: "other", severity, effects: [] };
    report.metadata.vulnerabilities[severity] = 1; report.metadata.vulnerabilities.total = 1;
    expect(() => classifyFullAudit(run(report, code))).toThrow(/not completely clean|BRACES_EXCEPTION_REJECTED/);
    expect(() => validateWithdrawnAudit(run(report, code))).toThrow();
  });
});

describe("official withdrawal evidence", () => {
  it("accepts the same advisory withdrawn, no active advisory listed, and the unchanged release", () => {
    for (const listed of [[], [{ ghsa_id: PIN.ghsa, withdrawn_at: WITHDRAWN_AT }]]) {
      expect(validateWithdrawnOfficialEvidence(withdrawnAdvisory(), listed, structuredClone(registry), NOW)).toMatchObject({ withdrawnAt: WITHDRAWN_AT, officialVersion: PIN.version });
    }
  });
  const mutations = [
    ["still active (withdrawn_at null)", (a) => { a.withdrawn_at = null; }],
    ["malformed withdrawal time", (a) => { a.withdrawn_at = "yesterday"; }],
    ["withdrawal before the reviewed update", (a) => { a.withdrawn_at = "2026-10-01T00:00:00Z"; }],
    ["withdrawal in the future", (a) => { a.withdrawn_at = "2026-12-01T00:00:00Z"; }],
    ["malformed update time", (a) => { a.updated_at = 5; }],
    ["different GHSA", (a) => { a.ghsa_id = "GHSA-xxxx-xxxx-xxxx"; }],
    ["different CVE", (a) => { a.cve_id = "CVE-2026-00000"; }],
    ["different page", (a) => { a.html_url += "x"; }],
    ["changed identifiers", (a) => { a.identifiers.push({ value: "X", type: "OTHER" }); }],
    ["changed package", (a) => { a.vulnerabilities[0].package.name = "micromatch"; }],
    ["changed range", (a) => { a.vulnerabilities[0].vulnerable_version_range = "< 4.0.0"; }],
    ["new patched version", (a) => { a.vulnerabilities[0].first_patched_version = "3.0.4"; }],
    ["additional affected package", (a) => { a.vulnerabilities.push(structuredClone(a.vulnerabilities[0])); }],
  ];
  it.each(mutations)("rejects an advisory with %s", (_label, change) => {
    const advisory = withdrawnAdvisory(); change(advisory);
    expect(() => validateWithdrawnOfficialEvidence(advisory, [], structuredClone(registry), NOW)).toThrow(/BRACES_EXCEPTION_REJECTED/);
  });
  it.each([
    ["another advisory", [{ ghsa_id: "GHSA-aaaa-bbbb-cccc", withdrawn_at: null }]],
    ["another withdrawn advisory", [{ ghsa_id: "GHSA-aaaa-bbbb-cccc", withdrawn_at: WITHDRAWN_AT }]],
    ["the same advisory still active", [{ ghsa_id: PIN.ghsa, withdrawn_at: null }]],
    ["the same advisory with a different withdrawal", [{ ghsa_id: PIN.ghsa, withdrawn_at: "2026-10-23T13:00:00Z" }]],
    ["a malformed list", { ghsa_id: PIN.ghsa }],
    ["a missing list", null],
  ])("rejects a matching-advisory result with %s", (_label, listed) => {
    expect(() => validateWithdrawnOfficialEvidence(withdrawnAdvisory(), listed, structuredClone(registry), NOW)).toThrow(/BRACES_EXCEPTION_REJECTED/);
  });
  it.each([
    ["a new version", (r) => { r.versions["3.0.4"] = structuredClone(r.versions["3.0.3"]); }],
    ["a different latest tag", (r) => { r["dist-tags"].latest = "3.0.2"; }],
    ["changed integrity", (r) => { r.versions["3.0.3"].dist.integrity = "sha512-x"; }],
    ["changed tarball", (r) => { r.versions["3.0.3"].dist.tarball += "?"; }],
    ["a missing release document", () => null],
  ])("rejects an official release with %s", (_label, change) => {
    const release = structuredClone(registry); const changed = change(release);
    expect(() => validateWithdrawnOfficialEvidence(withdrawnAdvisory(), [], changed === null ? null : release, NOW)).toThrow(/BRACES_EXCEPTION_REJECTED/);
  });
  it("never re-allows the advisory if it reappears: the active path demands live non-withdrawn proof", () => {
    // A reported braces finding classifies as "active"; the withdrawn record must not satisfy that path,
    expect(classifyFullAudit(run(structuredClone(activeFull), 1))).toBe("active");
    expect(() => validateOfficialEvidence(withdrawnAdvisory(), [{ ...withdrawnAdvisory() }], structuredClone(registry))).toThrow(/official advisory changed/);
    // and a republished (un-withdrawn) advisory carries a new update time, so it needs a fresh review too.
    const republished = { ...structuredClone(activeAdvisory), updated_at: "2026-10-24T00:00:00Z" };
    expect(() => validateOfficialEvidence(republished, [structuredClone(republished)], structuredClone(registry))).toThrow(/official advisory changed/);
    expect(() => validateWithdrawnOfficialEvidence(republished, [], structuredClone(registry), NOW)).toThrow(/not withdrawn/);
  });
  it("rejects missing or non-object advisory payloads", () => {
    for (const payload of [null, [], "withdrawn", {}]) expect(() => validateWithdrawnOfficialEvidence(payload, [], structuredClone(registry), NOW)).toThrow(/BRACES_EXCEPTION_REJECTED/);
  });
});

describe("unavailable official services fail closed", () => {
  const url = "https://api.github.com/advisories/GHSA-vfj7-8cjw-p6xm";
  it.each([
    ["network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["503", async () => new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } })],
    ["non-JSON", async () => Object.defineProperty(new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }), "url", { value: url })],
  ])("rejects a %s official lookup", async (_label, impl) => {
    await expect(fetchOfficialJson(url, impl)).rejects.toThrow();
  });
});

describe("withdrawn-mode verification on a synthetic installed tree", () => {
  const repo = fileURLToPath(new URL("../", import.meta.url));
  let root;
  const json = async (name, value) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), JSON.stringify(value)); };
  async function addPackage(name, pkg) { await json(`node_modules/${name}/package.json`, pkg); await writeFile(path.join(root, `node_modules/${name}/index.js`), "module.exports = {};\n"); }
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "braces-withdrawal-test-"));
    await cp(path.join(repo, "vendor"), path.join(root, "vendor"), { recursive: true });
    const manifest = { overrides: structuredClone(REVIEWED_OVERRIDES), name: "synthetic-withdrawal", version: "1.0.0", dependencies: { runtime: "1.0.0" }, devDependencies: { braces: "file:vendor/braces-3.0.3-local.tgz", consumer: "1.0.0" } };
    const upstreamManifest = JSON.parse(await readFile(path.join(root, "vendor/braces/package.json"), "utf8"));
    await json("package.json", manifest);
    await json("package-lock.json", { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
      "": manifest,
      "node_modules/braces": { version: PIN.version, resolved: "file:vendor/braces-3.0.3-local.tgz", integrity: PIN.candidateIntegrity, dev: true, dependencies: upstreamManifest.dependencies },
      "node_modules/consumer": { version: "1.0.0", dev: true, dependencies: { braces: "^3.0.3" } },
      "node_modules/fill-range": { version: "7.1.1", dev: true },
      "node_modules/runtime": { version: "1.0.0" },
    } });
    await cp(path.join(root, "vendor/braces"), path.join(root, "node_modules/braces"), { recursive: true });
    await addPackage("consumer", { name: "consumer", version: "1.0.0", dependencies: { braces: "^3.0.3" } });
    await addPackage("fill-range", { name: "fill-range", version: "7.1.1" });
    await addPackage("runtime", { name: "runtime", version: "1.0.0" });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const official = (overrides = {}) => vi.fn(async (url) => {
    if (url.startsWith("https://api.github.com/advisories/")) return overrides.advisory ?? withdrawnAdvisory();
    if (url.startsWith("https://api.github.com/advisories?")) return overrides.matching ?? [];
    if (url === "https://registry.npmjs.org/braces") return overrides.registry ?? structuredClone(registry);
    throw new Error(`unexpected official url ${url}`);
  });
  const LOCK_PACKAGES = 4;
  const verify = async (full, production, options) => verifyBracesException(full, production, root, { installedBefore: await inspectInstalledBraces(root), ...options });

  it("passes a clean audit with live official withdrawal proof and re-verifies the patched local copy", async () => {
    const fetchJson = official();
    const proof = await verify(run(cleanReport(LOCK_PACKAGES)), run(cleanReport(LOCK_PACKAGES)), { fetchJson });
    expect(proof).toMatchObject({ format: "aqlan-braces-advisory-withdrawn-v1", mode: "withdrawn", advisory: PIN.ghsa, package: PIN.package, version: PIN.version, auditedPackages: [] });
    expect(proof.official.withdrawnAt).toBe(WITHDRAWN_AT);
    expect(proof.installedCopies).toEqual([{ path: "node_modules/braces", name: PIN.package, version: PIN.version, files: PIN.files }]);
    expect(proof.patchSha256).toBe(PIN.patchSha256);
    expect(fetchJson).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await readFile(path.join(root, ".dependency-audit/exception-proof.json"), "utf8")).mode).toBe("withdrawn");
  });

  it.each([
    ["patch drift", async () => writeFile(path.join(root, "vendor/braces-security.patch"), "tampered\n"), /patch content changed/],
    ["local archive integrity drift", async () => writeFile(path.join(root, "vendor/braces-3.0.3-local.tgz"), "tampered"), /local package archive changed/],
    ["installed source drift", async () => writeFile(path.join(root, "node_modules/braces/index.js"), "module.exports = {};\n"), /file set\/hash differs/],
    ["an unexpected installed copy", async () => { const p = path.join(root, "node_modules/consumer/lib/node_modules/braces"); await mkdir(p, { recursive: true }); await writeFile(path.join(p, "index.js"), "module.exports = {};\n"); }, /shadow braces directory/],
    ["a missing installed copy", async () => rm(path.join(root, "node_modules/braces"), { recursive: true }), /required installed package missing: node_modules\/braces/],
  ])("rejects %s before any official lookup", async (_label, drift, message) => {
    const installedBefore = await inspectInstalledBraces(root);
    await drift();
    const fetchJson = official();
    await expect(verifyBracesException(run(cleanReport(LOCK_PACKAGES)), run(cleanReport(LOCK_PACKAGES)), root, { fetchJson, installedBefore })).rejects.toThrow(message);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it.each([
    ["no pre-audit installation snapshot", () => undefined],
    ["an installation changed after the audits ran", async () => { const before = await inspectInstalledBraces(root); await writeFile(path.join(root, "node_modules/runtime/package.json"), JSON.stringify({ name: "runtime", version: "1.0.1" })); return before; }],
  ])("rejects %s before any official lookup", async (_label, snapshot) => {
    const installedBefore = await snapshot();
    const fetchJson = official();
    await expect(verifyBracesException(run(cleanReport(LOCK_PACKAGES)), run(cleanReport(LOCK_PACKAGES)), root, { fetchJson, installedBefore })).rejects.toThrow(/BRACES_EXCEPTION_REJECTED/);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it.each([
    ["an unavailable official service", () => vi.fn(async () => { throw new Error("BRACES_EXCEPTION_REJECTED: official lookup failed"); }), /official lookup failed/],
    ["a still-active advisory", () => official({ advisory: structuredClone(activeAdvisory) }), /not withdrawn/],
    ["another active advisory", () => official({ matching: [{ ghsa_id: "GHSA-aaaa-bbbb-cccc", withdrawn_at: null }] }), /still-active/],
  ])("rejects %s", async (_label, makeFetch, message) => {
    await expect(verify(run(cleanReport(LOCK_PACKAGES)), run(cleanReport(LOCK_PACKAGES)), { fetchJson: makeFetch() })).rejects.toThrow(message);
  });

  it("rejects audit totals that differ from the complete lock graph, and a production finding", async () => {
    await expect(verify(run(cleanReport(LOCK_PACKAGES + 1)), run(cleanReport(LOCK_PACKAGES)), { fetchJson: official() })).rejects.toThrow(/dependency total differs/);
    const production = cleanReport(LOCK_PACKAGES);
    production.vulnerabilities.other = { ...structuredClone(activeFull.vulnerabilities.braces), name: "other", severity: "low", effects: [] };
    production.metadata.vulnerabilities.low = 1; production.metadata.vulnerabilities.total = 1;
    await expect(verify(run(cleanReport(LOCK_PACKAGES)), run(production), { fetchJson: official() })).rejects.toThrow(/BRACES_EXCEPTION_REJECTED/);
  });
});

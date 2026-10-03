import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { validateAuditProcess, validateScopedAudit, validateOfficialEvidence } from "../lib/scoped-braces-exception.mjs";
import { fetchOfficialJson } from "../scripts/verify-braces-exception.mjs";

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/dependency-security/${name}.json`, import.meta.url), "utf8"));
const full = await load("full-audit");
const production = await load("production-audit");
const advisory = await load("advisory");
const matching = await load("matching-advisories");
const registry = await load("registry");
const run = (report = structuredClone(full), code = 1) => ({ report, code, signal: null, error: undefined });
function mutate(change) { const report = structuredClone(full); change(report); return run(report); }

describe("one-advisory graph, never wholesale package suppression", () => {
  it("retains six HIGH raw findings after eligibility validation", () => {
    const input = run(); const before = JSON.stringify(input);
    expect(validateScopedAudit(input).counts).toEqual({ info: 0, low: 0, moderate: 0, high: 6, critical: 0, total: 6 });
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each([
    ["removed graph", (r) => { delete r.vulnerabilities; }],
    ["unknown report format", (r) => { r.auditReportVersion = 3; }],
    ["contradictory count", (r) => { r.metadata.vulnerabilities.high = 5; }],
    ["impossible dependency total", (r) => { r.metadata.dependencies.total = 0; }],
    ["missing total", (r) => { delete r.metadata.vulnerabilities.total; }],
    ["malformed counts", (r) => { r.metadata.vulnerabilities.high = "6"; }],
    ["explicit error", (r) => { r.error = null; }],
    ["different GHSA", (r) => { r.vulnerabilities.braces.via[0].url += "x"; }],
    ["changed range", (r) => { r.vulnerabilities.braces.via[0].range = "*"; }],
    ["changed source", (r) => { r.vulnerabilities.braces.via[0].source += 1; }],
    ["unknown leaf property", (r) => { r.vulnerabilities.braces.via[0].newFinding = true; }],
    ["additional advisory on same package", (r) => { r.vulnerabilities.braces.via.push({ ...r.vulnerabilities.braces.via[0], source: 4 }); }],
    ["additional advisory on parent", (r) => { r.vulnerabilities.tailwindcss.via.push({ ...r.vulnerabilities.braces.via[0], name: "tailwindcss" }); }],
    ["dangling cause", (r) => { r.vulnerabilities.micromatch.via = ["missing"]; }],
    ["cycle", (r) => { r.vulnerabilities.micromatch.via = ["tailwindcss"]; }],
    ["empty causes", (r) => { r.vulnerabilities.braces.via = []; }],
    ["dangling effect", (r) => { r.vulnerabilities.braces.effects.push("missing"); }],
    ["path traversal", (r) => { r.vulnerabilities.braces.nodes = ["node_modules/../braces"]; }],
    ["empty installed paths", (r) => { r.vulnerabilities.braces.nodes = []; }],
    ["new low advisory", (r) => { const n = structuredClone(r.vulnerabilities.braces); n.name = "other"; n.severity = "low"; r.vulnerabilities.other = n; r.metadata.vulnerabilities.low += 1; r.metadata.vulnerabilities.total += 1; }],
  ])("rejects %s", (_label, change) => { expect(() => validateScopedAudit(mutate(change))).toThrow(); });
  it.each([0, 2, null])("rejects contradictory full process status %s", (code) => { expect(() => validateScopedAudit(run(full, code))).toThrow(); });
  it("rejects signals and spawn errors even with eligible counts", () => {
    expect(() => validateScopedAudit({ ...run(), signal: "SIGTERM" })).toThrow();
    expect(() => validateScopedAudit({ ...run(), error: new Error("failed") })).toThrow();
  });
  it("rejects missing/disappeared advisory instead of silently retaining the exception", () => {
    expect(() => validateScopedAudit(run(production, 0))).toThrow(/disappeared/);
  });
  it("validates production audit separately without relaxing moderate threshold", () => {
    expect(() => validateAuditProcess(run(production, 0), true)).not.toThrow();
    expect(() => validateAuditProcess(run(), true)).toThrow();
    expect(() => validateAuditProcess(run(production, 1), true)).toThrow();
  });
  it("rejects a production-only low advisory absent from the full report", () => {
    const report = structuredClone(production);
    report.vulnerabilities.other = { ...structuredClone(full.vulnerabilities.braces), name: "other", severity: "low" };
    report.metadata.vulnerabilities.low = 1; report.metadata.vulnerabilities.total = 1;
    expect(() => validateAuditProcess(run(report, 0), true)).toThrow(/additional production/);
  });
  it("binds every affected node and consumer cause to verified installed paths", () => {
    const packages = {}; const edges = {};
    for (const node of Object.values(full.vulnerabilities)) for (const p of node.nodes) {
      packages[p] = { name: node.name, version: node.name === "braces" ? "3.0.3" : "1.0.0" };
      edges[p] = node.via.filter((cause) => typeof cause === "string").map((name) => ({ name, path: full.vulnerabilities[name].nodes[0] }));
    }
    const installed = { packages, edges, bracesPaths: ["node_modules/braces"] };
    expect(() => validateScopedAudit(run(), installed)).not.toThrow();
    installed.bracesPaths.push("node_modules/extra/node_modules/braces");
    expect(() => validateScopedAudit(run(), installed)).toThrow();
    installed.bracesPaths.pop();
    edges["node_modules/micromatch"] = [];
    expect(() => validateScopedAudit(run(), installed)).toThrow(/resolve/);
  });
});

describe("fresh official advisory and release removal triggers", () => {
  it("accepts exact official evidence with no official fix", () => { expect(validateOfficialEvidence(advisory, matching, registry).officialVersion).toBe("3.0.3"); });
  it.each([
    ["missing CWE", (a) => { delete a.cwes; }],
    ["changed CVSS", (a) => { a.cvss.score = 0; }],
    ["malformed description", (a) => { a.description = null; }],
    ["CVE", (a) => { a.cve_id = "CVE-OTHER"; }],
    ["advisory update", (a) => { a.updated_at = "2099-01-01T00:00:00Z"; }],
    ["withdrawal", (a) => { a.withdrawn_at = "2026-10-03T00:00:00Z"; }],
    ["fixed release", (a) => { a.vulnerabilities[0].first_patched_version = "3.0.4"; }],
    ["ecosystem", (a) => { a.vulnerabilities[0].package.ecosystem = "other"; }],
    ["range", (a) => { a.vulnerabilities[0].vulnerable_version_range = "< 3.0.4"; }],
  ])("blocks changed %s", (_label, change) => { const a = structuredClone(advisory); change(a); expect(() => validateOfficialEvidence(a, matching, registry)).toThrow(); });
  it("blocks additional or missing fresh advisories", () => {
    expect(() => validateOfficialEvidence(advisory, [], registry)).toThrow();
    expect(() => validateOfficialEvidence(advisory, [...matching, { ghsa_id: "new" }], registry)).toThrow();
  });
  it("blocks new registry release even when latest was not advanced", () => {
    const r = structuredClone(registry); r.versions["3.0.4-beta.0"] = {};
    expect(() => validateOfficialEvidence(advisory, matching, r)).toThrow();
  });
  it("blocks changed official artifact integrity", () => {
    const r = structuredClone(registry); r.versions["3.0.3"].dist.integrity = "changed";
    expect(() => validateOfficialEvidence(advisory, matching, r)).toThrow();
  });
  it("fails on network, HTTP, malformed and paginated official lookups", async () => {
    const url = "https://api.github.com/advisories/GHSA-vfj7-8cjw-p6xm";
    await expect(fetchOfficialJson(url, async () => { throw new Error("network failure"); })).rejects.toThrow();
    for (const response of [
      { ok: false, url },
      { ok: true, url: "https://other.test", headers: new Headers() },
      { ok: true, url, headers: new Headers({ "content-type": "text/html" }) },
      { ok: true, url, headers: new Headers({ "content-type": "application/json", link: '<x>; rel="next"' }) },
    ]) await expect(fetchOfficialJson(url, async () => response)).rejects.toThrow();
    const bad = new Response("not json", { headers: { "content-type": "application/json" } });
    Object.defineProperty(bad, "url", { value: url });
    await expect(fetchOfficialJson(url, async () => bad)).rejects.toThrow();
  });
});

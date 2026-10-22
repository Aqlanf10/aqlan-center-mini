import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CI_REQUIRED_NPM_MAJOR } from "../lib/env-contract";

const workflow = readFileSync(join(__dirname, "../.github/workflows/appointment-browser-acceptance.yml"), "utf8");
const journeyPath = "__tests__/security-http/appointment-connected-acceptance.test.ts";
const journey = readFileSync(join(__dirname, "..", journeyPath), "utf8");
const overlayStep = "Verify pinned application and overlay only the journey";
const pgStep = "Verify disposable PostgreSQL target and major";
const proofStep = "Record bounded acceptance result";
const temporary: string[] = [];
function shellBody(name: string) {
  const steps = workflow.split(/^ {6}- /m).slice(1).filter(block => block.startsWith(`name: ${name}\n`));
  expect(steps).toHaveLength(1);
  const literal = steps[0].match(/^ {8}run: \|\n([\s\S]*)$/m);
  expect(literal).not.toBeNull();
  // Comments belonging to the next step are deliberately outside the literal.
  const lines = literal![1].trimEnd().split("\n").filter(line => !/^ {6}#/.test(line));
  expect(lines.every(line => line.startsWith("          ") || line === "")).toBe(true);
  return lines.map(line => line.slice(10)).join("\n") + "\n";
}
function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
}
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000,
    env: { NODE_ENV: "test", PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
}
function commit(cwd: string) {
  git(cwd, "add", ".");
  git(cwd, "-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Synthetic acceptance source");
  return git(cwd, "rev-parse", "HEAD");
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aqlan-appointment-overlay-")); temporary.push(root);
  const repo = join(root, "app"); mkdirSync(repo);
  git(repo, "init", "--initial-branch=main");
  write(repo, "app/untouched.ts", "export const product = 'pinned';\n");
  write(repo, "__tests__/security-http/existing.test.ts", "// existing harness sentinel\n");
  const appHead = commit(repo);
  const probes = join(repo, "appointment-acceptance-probes"); mkdirSync(probes);
  git(probes, "init", "--initial-branch=review");
  write(probes, journeyPath, "// synthetic journey only\n");
  write(probes, "app/untouched.ts", "DO NOT COPY THIS RUNTIME SOURCE\n");
  const probeHead = commit(probes);
  const output = join(root, "source-output");
  return { root, repo, probes, appHead, probeHead, output };
}
function run(f: ReturnType<typeof fixture>, overrides: Record<string, string> = {}) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", shellBody(overlayStep)], {
    cwd: f.repo, encoding: "utf8", timeout: 10_000,
    env: { NODE_ENV: "test", PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      FINAL_APP_SHA: f.appHead, EXPECTED_PROBE_SHA: f.probeHead,
      EXPECTED_BASE_REF: "integration/nonfinancial-20261022", ACTUAL_BASE_REF: "integration/nonfinancial-20261022",
      GITHUB_OUTPUT: f.output, ...overrides },
  });
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("isolated appointment hosted workflow", () => {
  it("has a dedicated same-repository pull-request trigger and only read permission", () => {
    expect(workflow).toContain("branches: [integration/nonfinancial-20261022]");
    expect(workflow).toContain("FINAL_APP_SHA: '181cab90350c421d40fed24fb92a7c8fa0667b44'");
    expect(workflow).toContain("github.repository == 'Aqlanf10/aqlan-center-mini'");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain("github.event.pull_request.head.ref == 'review/appointment-browser-acceptance-hosted'");
    expect(workflow).toContain("github.event.pull_request.base.ref == 'integration/nonfinancial-20261022'");
    expect(workflow).toContain("permissions:\n  contents: read\n");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(workflow).not.toMatch(/pull_request_target|workflow_dispatch|workflow_run|secrets\.|vars\.|environment:|continue-on-error|upload-artifact|download-artifact|railway (?:up|deploy|variables)|git push/);
    expect(workflow).toContain(`run: npm run test:security-http -- ${journeyPath}`);
    expect(workflow).toContain("run: npm run build");
    expect(workflow).toContain("run: npx playwright install --with-deps chromium");
  });
  it("installs the live CI npm major before dependencies and keeps the environment verifier mandatory", () => {
    const setup = workflow.indexOf("name: Set up Node.js");
    const npm = workflow.indexOf(`run: npm install -g npm@${CI_REQUIRED_NPM_MAJOR}\n`);
    const dependencies = workflow.indexOf("run: npm ci --ignore-scripts --no-audit --no-fund");
    const verifier = workflow.indexOf("name: Verify environment contract\n        run: npm run verify:environment\n");
    const build = workflow.indexOf("name: Build the unchanged pinned application");
    expect(setup).toBeGreaterThan(-1);
    expect(npm).toBeGreaterThan(setup);
    expect(dependencies).toBeGreaterThan(npm);
    expect(verifier).toBeGreaterThan(dependencies);
    expect(build).toBeGreaterThan(verifier);
    expect(workflow).not.toMatch(/\bCI:\s*["']?false|\bCI=false|verify:environment\s*\|\|/);
  });
  it.each([overlayStep, pgStep, proofStep])("uses valid fail-closed Bash for %s", name => {
    const source = shellBody(name);
    expect(source.startsWith("set -euo pipefail\n")).toBe(true);
    expect(spawnSync("bash", ["-n"], { input: source, encoding: "utf8" }).status).toBe(0);
  });
  it("overlays only the one permitted test and preserves exact app source/HEAD despite different probe runtime", () => {
    const f = fixture(); const result = run(f);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.repo, journeyPath), "utf8")).toBe("// synthetic journey only\n");
    expect(readFileSync(join(f.repo, "app/untouched.ts"), "utf8")).toBe("export const product = 'pinned';\n");
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.appHead);
    expect(git(f.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(`?? ${journeyPath}`);
    expect(existsSync(f.probes)).toBe(false);
    expect(readFileSync(f.output, "utf8")).toBe(`app_sha=${f.appHead}\nprobe_sha=${f.probeHead}\n`);
  });
  it.each(["PENDING_FINAL_PUBLISHED_APPLICATION_SHA", "a".repeat(40), "abc\nforged=metadata"])("refuses unresolved, wrong, or malformed product pin %s", head => {
    const f = fixture(); expect(run(f, { FINAL_APP_SHA: head }).status).not.toBe(0);
    expect(existsSync(f.output)).toBe(false); expect(existsSync(join(f.repo, journeyPath))).toBe(false);
  });
  it.each<Record<string, string>>([
    { EXPECTED_PROBE_SHA: "b".repeat(40) },
    { ACTUAL_BASE_REF: "main" },
  ])("refuses mismatched probe SHA or branch %j", override => {
    const f = fixture(); expect(run(f, override).status).not.toBe(0); expect(existsSync(f.output)).toBe(false);
  });
  it.each(["app/untouched.ts", "unexpected-new-file.txt"])("refuses any product change outside the allowlist: %s", path => {
    const f = fixture(); write(f.repo, path, "unexpected runtime/build input\n");
    expect(run(f).status).not.toBe(0); expect(existsSync(f.output)).toBe(false);
  });
  it("refuses a symlink probe instead of following it into runtime source", () => {
    const f = fixture(); rmSync(join(f.probes, journeyPath));
    symlinkSync("../../app/untouched.ts", join(f.probes, journeyPath));
    f.probeHead = commit(f.probes);
    expect(run(f).status).not.toBe(0); expect(existsSync(f.output)).toBe(false);
    expect(readFileSync(join(f.repo, "app/untouched.ts"), "utf8")).toBe("export const product = 'pinned';\n");
  });
  it("refuses an untracked probe even when its bytes exist", () => {
    const f = fixture(); git(f.probes, "rm", journeyPath); f.probeHead = commit(f.probes);
    write(f.probes, journeyPath, "untracked test input\n");
    expect(run(f).status).not.toBe(0); expect(existsSync(f.output)).toBe(false);
  });
  it("binds PostgreSQL to a loopback disposable target with the pinned major", () => {
    expect(workflow).toContain("image: postgres:18.6@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336");
    expect(workflow).toContain("127.0.0.1:5432:5432");
    const guard = shellBody(pgStep);
    for (const expected of ["url.hostname !== '127.0.0.1'", "url.port !== '5432'", "url.pathname !== '/aqlan_p1_test'", "url.username !== 'ci'", "SHOW server_version_num", "/ 10000) !== 18"]) expect(guard).toContain(expected);
  });
  it("contains no response mocks, flaky delays, external delivery, or synthetic browser source", () => {
    expect(journey).toContain('from "./_server"');
    expect(journey).toContain('from "../helpers/guarded-browser-routes"');
    expect(journey).toContain('serviceWorkers: "block"');
    expect(journey.indexOf("await guardBrowserRoutes(")).toBeLessThan(journey.indexOf("await context.newPage()"));
    expect(journey).toContain('await route.abort("blockedbyclient")');
    expect(journey).not.toMatch(/route\.fulfill|page\.route|setContent\(|addScriptTag|waitForTimeout|setTimeout\(|test\.skip|it\.skip|describe\.skip/);
    expect(journey).toContain("expect(await financialFingerprint()).toEqual(financialBefore)");
    expect(journey).toContain("expect(financialBefore.invoices.count).toBeGreaterThan(0)");
    expect(journey).toContain("expect(financialBefore.invoice_items.count).toBeGreaterThan(0)");
    expect(journey).toContain("const p = financialPatient;");
    expect(journey).toContain("new Set(rows.map(row => row.transaction)).size).toBe(1)");
    expect(journey).toContain("expect(rejection.status()).toBe(409)");
  });
});

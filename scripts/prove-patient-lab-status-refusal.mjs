import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Temporary isolated proof only. This script and its exact-branch workflow must
// never be copied into the five-file release candidate.
const baselineCommit = "05bde7c66c0f7fc2c5a4066e5dc873c2ade60f5f";
const baselineBlob = "f8458d3b250d6ec169cec09a863d09ba829c674c";
const component = "components/PatientLabOrders.tsx";
const test = "__tests__/patient-lab-status-refusal.test.tsx";
const expected = {
  ".github/workflows/ci.yml": "f730b1b95b0328289658ce1e3e473cdd407fec83",
  "__tests__/patient-lab-status-refusal.test.tsx": "af4e14de0cc430e77b6f990fa7011ecc3a4c81b0",
  "__tests__/security-http/patient-lab-status-refusal-ui.test.ts": "cbb871a799391df14aecb33fabdfe7e12fa63d93",
  "components/PatientLabOrders.tsx": "d33865c66401c1c2a2c05e32a83b331a1a28ac84",
  "docs/PATIENT_LAB_STATUS_REFUSAL.md": "0b2a694c9d5c3a10737feaa7cfa5fa4f5f163d2f",
};
const output = ".lab-status-counterfactual-artifacts";
const count = 67;
function assert(condition, message) { if (!condition) throw new Error(message); }
assert(process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true", "Reviewed GitHub CI runner required");
assert(!Object.keys(process.env).some((key) => key.startsWith("RAILWAY_")), "Railway environment refused");
assert(!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL, "Database-bearing proof environment refused");
const candidateCommit = process.env.LAB_STATUS_CANDIDATE_COMMIT ?? "";
assert(/^[0-9a-f]{40}$/.test(candidateCommit), "Exact candidate commit required");
mkdirSync(output, { recursive: true });
function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 30_000 });
  assert(result.status === 0 && !result.signal && !result.error, `Git check failed: ${args.join(" ")}`);
  return result.stdout.trim();
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert(git("show", "-s", "--format=%P", "HEAD") === candidateCommit,
  "Proof commit must have the exact reviewed candidate as its sole parent");
assert(git("diff", "--name-only") === "", "Tracked checkout is dirty before proof");
for (const [path, blob] of Object.entries(expected)) {
  assert(git("rev-parse", `${candidateCommit}:${path}`) === blob, `Reviewed candidate identity changed: ${path}`);
  assert(git("hash-object", path) === blob, `Checkout differs from reviewed source: ${path}`);
}
assert(git("rev-parse", `${baselineCommit}:${component}`) === baselineBlob, "Baseline component identity changed");
const changed = git("diff", "--name-only", candidateCommit, "HEAD").split("\n").filter(Boolean).sort();
assert(JSON.stringify(changed) === JSON.stringify([
  ".github/workflows/lab-status-counterfactual.yml",
  "scripts/prove-patient-lab-status-refusal.mjs",
]), "Temporary proof branch changed more than the two reviewed proof files");
const candidateBytes = readFileSync(component), testBytes = readFileSync(test);
const baselineRead = spawnSync("git", ["cat-file", "blob", baselineBlob], { timeout: 30_000 });
assert(baselineRead.status === 0 && !baselineRead.signal && !baselineRead.error, "Exact baseline blob unavailable");
const baselineBytes = baselineRead.stdout;
const manifest = {
  candidateCommit, candidateTree: git("rev-parse", `${candidateCommit}^{tree}`),
  baselineCommit, baselineBlob, reviewedBlobs: expected, proofCommit: git("rev-parse", "HEAD"),
  candidateComponentSha256: sha256(candidateBytes), baselineComponentSha256: sha256(baselineBytes),
  testSha256: sha256(testBytes), stages: [], completed: false,
};
const saveManifest = () => writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
saveManifest();

function runStage(name) {
  const reportPath = join(output, `${name}.json`);
  const command = [process.execPath, "node_modules/vitest/vitest.mjs", "run", test,
    "--reporter=json", `--outputFile=${reportPath}`];
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      CI: "true", NODE_ENV: "test", TZ: "UTC" },
  });
  writeFileSync(join(output, `${name}.stdout.txt`), result.stdout ?? "");
  writeFileSync(join(output, `${name}.stderr.txt`), result.stderr ?? "");
  writeFileSync(join(output, `${name}.process.json`), JSON.stringify({ command,
    status: result.status, signal: result.signal, error: result.error ? String(result.error) : null }, null, 2));
  assert(!result.signal && !result.error, `${name} did not finish normally`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const cases = report.testResults.flatMap((suite) => suite.assertionResults);
  assert(report.numTotalTests === count && cases.length === count, `${name} did not execute all ${count} cases`);
  assert(new Set(cases.map((entry) => entry.fullName)).size === count, `${name} has duplicate test identities`);
  assert(cases.every((entry) => ["passed", "failed"].includes(entry.status)), `${name} skipped cases`);
  manifest.stages.push({ name, status: result.status, passed: report.numPassedTests, failed: report.numFailedTests,
    reportSha256: sha256(readFileSync(reportPath)), componentBlob: git("hash-object", component),
    cases: cases.map((entry) => ({ name: entry.fullName, status: entry.status })) });
  saveManifest();
  assert(readFileSync(test).equals(testBytes), `${name} altered focused assertions`);
  return { report, cases, result };
}
function assertCandidate(stage) {
  assert(stage.result.status === 0 && stage.report.success === true, "Candidate focused suite did not pass");
  assert(stage.report.numPassedTests === count && stage.report.numFailedTests === 0, "Candidate totals differ");
  assert(stage.cases.every((entry) => entry.status === "passed"), "Candidate contains a nonpassing case");
}
// Do not prescribe an invented full baseline failure count. Require failures
// at specific semantic regressions, plus unchanged successful-status controls;
// retain every actual failure, including baseline unhandled rejection evidence.
const negativeSuffixes = [
  "contains unreadable refusal JSON",
  "does not repeat the existing API conflict message's false refresh claim",
  "contains a lost response, reports uncertainty, and never automatically repeats the mutation",
  "blocks same-tick duplicates and other mutations until the refusal settles",
];
const positiveSuffix = "preserves successful HTTP status handling without requiring a readable success body";
let failure;
try {
  const before = runStage("candidate-before");
  assertCandidate(before);
  writeFileSync(component, baselineBytes);
  assert(git("hash-object", component) === baselineBlob, "Baseline substitution was not byte-exact");
  const original = runStage("original");
  assert(original.result.status === 1 && original.report.success === false, "Baseline did not fail as expected");
  const identities = new Set(original.cases.map((entry) => entry.fullName));
  assert(before.cases.every((entry) => identities.has(entry.fullName)), "Baseline case identity changed");
  for (const suffix of negativeSuffixes) {
    const cases = original.cases.filter((entry) => entry.fullName.endsWith(suffix));
    assert(cases.length === 3 && cases.every((entry) => entry.status === "failed" && entry.failureMessages?.length > 0),
      `Missing semantic regression failures: ${suffix}`);
  }
  const controls = original.cases.filter((entry) => entry.fullName.endsWith(positiveSuffix));
  assert(controls.length === 3 && controls.every((entry) => entry.status === "passed"), "Unchanged success controls failed");
} catch (error) {
  failure = error;
} finally {
  writeFileSync(component, candidateBytes);
  assert(git("hash-object", component) === expected[component], "Candidate restore was not byte-exact");
  assert(readFileSync(test).equals(testBytes), "Focused assertions changed during proof");
  try {
    const after = runStage("candidate-after");
    assertCandidate(after);
    assert(git("diff", "--name-only") === "", "Tracked source changed during proof");
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Counterfactual and restoration verification failed") : error;
  }
  manifest.completed = !failure;
  manifest.failure = failure ? String(failure) : null;
  saveManifest();
}
if (failure) throw failure;
console.log("Reviewed candidate passed, exact baseline demonstrated named semantic failures with unchanged success controls, and byte-restored candidate passed.");

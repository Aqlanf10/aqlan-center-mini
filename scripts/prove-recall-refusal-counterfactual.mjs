import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const candidateCommit = "ca0b0ca13e05fa3d5737177f83680400e7b8b6a7";
const candidateTree = "35be9789146b0d2e96ba31384e3f4c7975d1fa42";
const baselineCommit = "ea312ad872897b07ad2241c09084837dee355dae";
const baselineBlob = "b78d3d9995936931e36b0f2315a0d30b74a18494";
const page = "app/recall/page.tsx";
const test = "__tests__/recall-mutation-refusal.test.tsx";
const testBlob = "2dd7d4f97adafd29bb81be05435e87b5f7c1a7fc";
const candidateBlob = "2e2ff316eea208f26e4c7e5ad24114ee1b208063";
const output = ".recall-counterfactual-artifacts";
mkdirSync(output, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 30_000 });
  assert(result.status === 0 && !result.signal && !result.error, `Git check failed: ${args.join(" ")}`);
  return result.stdout.trim();
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const candidateBytes = readFileSync(page);
const testBytes = readFileSync(test);
assert(git("rev-parse", candidateCommit + "^{tree}") === candidateTree, "Candidate tree changed");
assert(git("rev-parse", candidateCommit + ":" + page) === candidateBlob, "Candidate page identity changed");
assert(git("rev-parse", baselineCommit + ":" + page) === baselineBlob, "Original page identity changed");
assert(git("hash-object", page) === candidateBlob, "Checkout does not contain reviewed candidate page");
assert(git("hash-object", test) === testBlob, "Focused assertions changed");
const changedFromCandidate = git("diff", "--name-only", candidateCommit, "HEAD").split("\n").filter(Boolean).sort();
assert(JSON.stringify(changedFromCandidate) === JSON.stringify([
  ".github/workflows/recall-counterfactual.yml",
  "scripts/prove-recall-refusal-counterfactual.mjs",
]), "Temporary branch has changes beyond the two reviewed proof files");

const baselineRead = spawnSync("git", ["cat-file", "blob", baselineBlob], { timeout: 30_000 });
assert(baselineRead.status === 0 && !baselineRead.signal && !baselineRead.error, "Cannot read exact original page");
const baselineBytes = baselineRead.stdout;
const manifest = {
  candidateCommit, candidateTree, baselineCommit, baselineBlob, candidateBlob, testBlob,
  candidatePageSha256: sha256(candidateBytes), originalPageSha256: sha256(baselineBytes),
  testSha256: sha256(testBytes), proofCommit: git("rev-parse", "HEAD"),
  stages: [], completed: false,
};
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));

function runStage(name) {
  const reportPath = join(output, name + ".json");
  const command = [process.execPath, "node_modules/vitest/vitest.mjs", "run", test,
    "--reporter=json", "--outputFile=" + reportPath];
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CI: "true" },
  });
  writeFileSync(join(output, name + ".stdout.txt"), result.stdout ?? "");
  writeFileSync(join(output, name + ".stderr.txt"), result.stderr ?? "");
  const processResult = { command, status: result.status, signal: result.signal,
    error: result.error ? String(result.error) : null };
  writeFileSync(join(output, name + ".process.json"), JSON.stringify(processResult, null, 2));
  assert(!result.signal && !result.error, name + " process did not complete normally");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const cases = report.testResults.flatMap((suite) => suite.assertionResults);
  assert(report.numTotalTests === 68 && cases.length === 68, name + " did not execute all 68 cases");
  assert(new Set(cases.map((entry) => entry.fullName)).size === 68, name + " duplicated test identities");
  assert(cases.every((entry) => ["passed", "failed"].includes(entry.status)), name + " skipped or pending cases");
  const stage = {
    name, status: result.status, passed: report.numPassedTests, failed: report.numFailedTests,
    reportSha256: sha256(readFileSync(reportPath)), pageBlob: git("hash-object", page),
    cases: cases.map((entry) => ({ name: entry.fullName, status: entry.status })),
  };
  manifest.stages.push(stage);
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  assert(readFileSync(test).equals(testBytes), name + " altered assertions");
  return { report, cases, result };
}

function assertCandidate(stage) {
  assert(stage.result.status === 0 && stage.report.success === true, "Candidate focused suite did not pass");
  assert(stage.report.numPassedTests === 68 && stage.report.numFailedTests === 0, "Candidate count mismatch");
  assert(stage.cases.every((entry) => entry.status === "passed"), "Candidate contains a non-passing case");
}
const controlSuffixes = [
  "retains a network failure without refreshing or retrying the mutation",
  "refreshes only after a successful write and shows the canonical returned list",
  "reports a failed refresh after success without inventing an empty list or repeating the write",
  "keeps duplicate commands blocked while the successful write's canonical refresh is pending",
  "preserves the existing successful-status refresh behavior with an unreadable response body",
];
let failure;
try {
  const before = runStage("candidate-before");
  assertCandidate(before);
  writeFileSync(page, baselineBytes);
  assert(git("hash-object", page) === baselineBlob, "Original substitution was not byte-exact");
  const original = runStage("original");
  assert(original.result.status === 1 && original.report.success === false, "Original did not fail as expected");
  assert(original.report.numPassedTests === 20 && original.report.numFailedTests === 48, "Unexpected original outcomes; retain and inspect the actual reports");
  const byName = new Map(original.cases.map((entry) => [entry.fullName, entry]));
  assert(before.cases.every((entry) => byName.has(entry.fullName)), "Original case identity changed");
  for (const suffix of controlSuffixes) {
    const controls = original.cases.filter((entry) => entry.fullName.endsWith(suffix));
    assert(controls.length === 4 && controls.every((entry) => entry.status === "passed"), "An unchanged positive control failed: " + suffix);
  }
  const controls = original.cases.filter((entry) => controlSuffixes.some((suffix) => entry.fullName.endsWith(suffix)));
  assert(controls.length === 20, "Positive control identity mismatch");
  for (const entry of original.cases) {
    if (controls.includes(entry)) continue;
    assert(entry.status === "failed" && entry.failureMessages?.length > 0, "Missing semantic-negative failure evidence");
  }
} catch (error) {
  failure = error;
} finally {
  writeFileSync(page, candidateBytes);
  assert(git("hash-object", page) === candidateBlob, "Candidate restore was not byte-exact");
  assert(readFileSync(test).equals(testBytes), "Focused test changed during counterfactual");
  const after = runStage("candidate-after");
  assertCandidate(after);
  manifest.completed = !failure;
  manifest.failure = failure ? String(failure) : null;
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
}
if (failure) throw failure;
console.log("Reviewed candidate 68 pass; exact original 48 fail / 20 unchanged controls pass; restored candidate 68 pass.");

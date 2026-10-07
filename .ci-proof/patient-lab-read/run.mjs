import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// TEMPORARY NO-PR PROOF. Never copy this runner, route, fixtures or workflow to release.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, ".patient-lab-read-proof-results");
const manifestPath = ".ci-proof/patient-lab-read/manifest.json";
const manifestSha = "dc4386f194775a0cd70175361df133690a349fc9a855ddcf7844763d1379283b";
const exactUrl = "postgresql://ci:ci@127.0.0.1:5432/aqlan_p1_test?sslmode=disable";
const testSecret = "ci-placeholder-secret-0123456789abcdef";
const require = (ok, message) => { if (!ok) throw new Error(message); };
const sha = (value) => createHash("sha256").update(value).digest("hex");
const blob = (value) => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const now = () => new Date().toISOString();
function bytes(path) {
  const full = join(root, path);
  require(lstatSync(full).isFile() && !lstatSync(full).isSymbolicLink(), `Regular file required: ${path}`);
  require(realpathSync(full) === full, `Symlink traversal refused: ${path}`);
  return readFileSync(full);
}
require(sha(bytes(manifestPath)) === manifestSha, "Reviewed proof manifest changed");
const pinned = JSON.parse(bytes(manifestPath).toString("utf8"));
const component = pinned.originalComponent.path;
const candidate = pinned.candidateFiles.find((item) => item.path === component);
function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  require(result.status === 0 && !result.signal && !result.error, `Read-only Git check failed: ${args.join(" ")}`);
  return result.stdout.trim();
}
function environment() {
  require(process.cwd() === root && realpathSync(process.env.GITHUB_WORKSPACE ?? "") === root, "Exact checkout root required");
  require(process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true", "Owned GitHub Actions CI required");
  require(process.env.RUNNER_ENVIRONMENT === "github-hosted", "Disposable GitHub-hosted runner required");
  require(process.env.GITHUB_REPOSITORY === pinned.repository && process.env.GITHUB_JOB === pinned.proofJob, "Unexpected repository/job");
  require(process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF === pinned.proofRef, "Only the exact temporary push ref is allowed; no PR");
  require(/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? ""), "Immutable event commit required");
  for (const name of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) require(/^[1-9][0-9]*$/.test(process.env[name] ?? ""), `Missing ${name}`);
  require(!Object.keys(process.env).some((key) => key.startsWith("RAILWAY_")), "Railway environment refused");
  for (const name of ["POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING", "SOURCE_DATABASE_URL", "PGHOST", "PGPORT",
    "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "USE_LOCAL_DB", "NODE_OPTIONS"]) {
    require(process.env[name] === undefined, `Alternate connection/runtime setting refused: ${name}`);
  }
  require(process.env.DATABASE_URL === exactUrl && process.env.TEST_DATABASE_URL === exactUrl, "Only the exact disposable loopback database URL is allowed");
  require(process.env.DATABASE_ENVIRONMENT === "test", "Explicit test database classification required");
  require(process.env.NODE_ENV === undefined || process.env.NODE_ENV === "test", "Production parent environment refused");
  require(process.env.SESSION_SECRET === testSecret, "Only the public synthetic CI secret is allowed");
  require(process.env.CLINIC_TIME_ZONE === "Asia/Aden" && process.env.SECURITY_HTTP_PORT === "3217", "Unexpected isolated harness settings");
}
function snapshot(version = "candidate") {
  environment();
  require(git("rev-parse", "HEAD") === process.env.GITHUB_SHA, "Checkout differs from immutable event commit");
  require(git("rev-list", "--parents", "-n", "1", "HEAD") === `${process.env.GITHUB_SHA} ${pinned.proofParentCommit}`, "Exactly reviewed previous proof must be the sole successor parent");
  require(git("rev-parse", `${pinned.baseCommit}^{tree}`) === pinned.baseTree, "Base tree differs");
  const clinicalPaths = pinned.candidateFiles.map((item) => item.path);
  require(clinicalPaths.length === 7 && new Set(clinicalPaths).size === 7, "Exactly seven clinical source files required");
  require(clinicalPaths.every((path) => !path.startsWith(".ci-proof/") && !path.startsWith(".github/")
    && !path.startsWith("app/proof-") && !pinned.proofOnlyFiles.includes(path)), "Proof-only source entered the clinical payload");
  const changed = git("diff", "--name-only", pinned.baseCommit, "HEAD", "--").split("\n").filter(Boolean).sort();
  require(JSON.stringify(changed) === JSON.stringify([...clinicalPaths, ...pinned.proofOnlyFiles].sort()), "Unexpected files in temporary proof commit");
  require(git("diff", "--cached", "--name-only") === "", "Index mutation refused");
  const working = git("diff", "--name-only", "HEAD", "--").split("\n").filter(Boolean);
  require(JSON.stringify(working) === JSON.stringify(version === "original" ? [component] : []), "Unexpected tracked working-tree changes");
  const files = pinned.candidateFiles.map((item) => {
    const expected = version === "original" && item.path === component ? pinned.originalComponent : item;
    const data = bytes(item.path);
    require(blob(data) === expected.gitBlob && sha(data) === expected.sha256 && data.length === expected.bytes, `Source identity differs: ${item.path}`);
    return { path: item.path, bytes: data.length, gitBlob: blob(data), sha256: sha(data) };
  });
  for (const item of pinned.protectedBaseFiles) {
    require(git("rev-parse", `${pinned.baseCommit}:${item.path}`) === item.gitBlob, `Pinned base blob differs: ${item.path}`);
    require(blob(bytes(item.path)) === item.gitBlob, `Protected original source changed: ${item.path}`);
  }
  for (const path of pinned.proofOnlyFiles) require(git("hash-object", path) === git("rev-parse", `HEAD:${path}`), `Proof source changed: ${path}`);
  require(sha(bytes(manifestPath)) === manifestSha, "Proof manifest changed during execution");
  for (const item of [...pinned.browserNegativeAssertions, pinned.browserReadInitialCountAssertion]) {
    require(bytes(item.path).toString("utf8").split("\n")[item.line - 1].trim() === item.statement, `Pinned browser assertion moved: ${item.path}:${item.line}`);
  }
  return { version, checkedAt: now(), files, protectedBaseFiles: pinned.protectedBaseFiles };
}
// The unchanged checkout depth contains this successor and its reviewed parent.
// Fetch only the pinned original base object if it is outside that shallow window.
// This read happens only inside the exact owned-CI context, before source execution.
function ensureReviewedBase() {
  environment();
  require(git("rev-parse", "HEAD") === process.env.GITHUB_SHA, "Checkout differs from immutable event commit");
  require(git("rev-list", "--parents", "-n", "1", "HEAD") === `${process.env.GITHUB_SHA} ${pinned.proofParentCommit}`,
    "Only the reviewed non-force proof successor is allowed");
  require(git("rev-parse", `${pinned.proofParentCommit}^{tree}`) === pinned.proofParentTree, "Reviewed predecessor tree differs");
  const predecessorParents = git("cat-file", "-p", pinned.proofParentCommit).split("\n\n", 1)[0].split("\n")
    .filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  require(JSON.stringify(predecessorParents) === JSON.stringify([pinned.baseCommit]), "Raw reviewed predecessor ancestry differs");
  const successorPaths = git("diff", "--name-only", pinned.proofParentCommit, "HEAD", "--").split("\n").filter(Boolean).sort();
  require(JSON.stringify(successorPaths) === JSON.stringify([manifestPath, ".ci-proof/patient-lab-read/run.mjs"].sort()),
    "Successor changed files outside the exact two-file classifier correction");
  const origin = git("remote", "get-url", "origin");
  require([`https://github.com/${pinned.repository}`, `https://github.com/${pinned.repository}.git`].includes(origin), "Unexpected source origin");
  const probe = spawnSync("git", ["cat-file", "-e", `${pinned.baseCommit}^{commit}`], { cwd: root, encoding: "utf8", timeout: 30_000 });
  require(!probe.signal && !probe.error && [0, 128].includes(probe.status), "Base-object lookup failed unexpectedly");
  let fetchRecord = null;
  if (probe.status !== 0) {
    const command = ["git", "fetch", "--no-tags", "--depth=1", "origin", pinned.baseCommit];
    const result = spawnSync(command[0], command.slice(1), { cwd: root, encoding: "utf8", timeout: 30_000 });
    fetchRecord = { command, status: result.status, signal: result.signal, error: result.error ? String(result.error) : null,
      stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    require(result.status === 0 && !result.signal && !result.error, "Exact reviewed base-object fetch failed");
  }
  require(git("rev-parse", `${pinned.baseCommit}^{tree}`) === pinned.baseTree, "Fetched reviewed base tree differs");
  return { origin, commit: pinned.baseCommit, predecessorParents, fetchedExactObject: probe.status !== 0,
    probeStatus: probe.status, fetch: fetchRecord };
}
const reviewedBaseRead = ensureReviewedBase();
const first = snapshot();
mkdirSync(output, { recursive: true });
const write = (name, value) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`);
const identity = {
  repository: pinned.repository, proofRef: pinned.proofRef, proofCommit: process.env.GITHUB_SHA, proofTree: git("rev-parse", "HEAD^{tree}"),
  baseCommit: pinned.baseCommit, baseTree: pinned.baseTree, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
  predecessorCommit: pinned.proofParentCommit, predecessorTree: pinned.proofParentTree,
  job: process.env.GITHUB_JOB, nodeVersion: process.version, manifestSha256: manifestSha, clinicalManifestSha256: pinned.clinicalManifestSha256,
  source: first, proofFiles: pinned.proofOnlyFiles.map((path) => ({ path, sha256: sha(bytes(path)), gitBlob: blob(bytes(path)) })),
  safeTargets: { hostname: "127.0.0.1", port: 5432, databases: ["aqlan_p1_test", "aqlan_sec_http"], postgresMajor: 18 },
  claims: pinned.claims, startedAt: now(),
  reviewedBaseRead,
};
if (process.argv[2] === "preflight") {
  write("preflight.json", identity);
  console.log("Exact proof/release separation, original CI bytes, source and disposable environment verified before installation.");
  process.exit(0);
}
require(process.argv[2] === "run", "Only preflight and run modes are supported");
write("identity.json", identity);
const { validatePostgresTestTarget } = await import(pathToFileURL(join(root, "__tests__/postgres/_safe-target.ts")).href);
function guardTarget() {
  environment();
  require(validatePostgresTestTarget(process.env).testUrl.toString() === exactUrl, "Canonical target guard chose a different target");
}
guardTarget();
write("target-guard.json", { canonicalGuard: "__tests__/postgres/_safe-target.ts", exactLoopbackOnly: true, checkedAt: now() });
const common = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  CI: "true", GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_JOB: pinned.proofJob,
  DATABASE_ENVIRONMENT: "test", DATABASE_URL: exactUrl, TEST_DATABASE_URL: exactUrl, SESSION_SECRET: testSecret,
  CLINIC_TIME_ZONE: "Asia/Aden", SECURITY_HTTP_PORT: "3217", NEXT_TELEMETRY_DISABLED: "1", TZ: "UTC", NO_COLOR: "1",
  PATIENT_LAB_READ_PROOF: "20261007",
};
const stages = [], summary = { ...identity, stages, completed: false, expectedUnitRed: false, expectedBrowserRed: false,
  restoredCandidateGreen: false, failure: null };
const save = () => write("summary.json", summary);
save();
function processStage(name, command, args, version, timeout, extra = {}) {
  guardTarget(); const source = snapshot(version);
  const out = openSync(join(output, `${name}.stdout.txt`), "w"), err = openSync(join(output, `${name}.stderr.txt`), "w");
  let result; const startedAt = now();
  try { result = spawnSync(command, args, { cwd: root, env: { ...common, NODE_ENV: "test", ...extra },
    stdio: ["ignore", out, err], timeout, killSignal: "SIGKILL" }); }
  finally { closeSync(out); closeSync(err); }
  const record = { name, command: [command, ...args], source, startedAt, endedAt: now(), status: result.status,
    signal: result.signal, error: result.error ? String(result.error) : null,
    stdoutSha256: sha(readFileSync(join(output, `${name}.stdout.txt`))), stderrSha256: sha(readFileSync(join(output, `${name}.stderr.txt`))) };
  write(`${name}.process.json`, record); stages.push(record); save(); snapshot(version);
  require(!result.signal && !result.error, `${name} did not finish normally`);
  return result;
}
function testStage(name, files, version, config, phase) {
  const reportPath = join(output, `${name}.json`);
  require(!existsSync(reportPath), `Stale report refused: ${name}`);
  const result = processStage(name, process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...(config ? ["--config", config] : []),
    ...files.map((item) => item.path), "--reporter=json", `--outputFile=${reportPath}`], version, 12 * 60_000,
    phase ? { PATIENT_LAB_READ_PROOF_PHASE: phase } : {});
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  require(report.testResults.length === files.length, `${name} collected an unexpected file count`);
  const cases = [];
  for (const file of files) {
    const suites = report.testResults.filter((suite) => suite.name.replaceAll("\\", "/").endsWith(`/${file.path}`));
    require(suites.length === 1 && suites[0].assertionResults.length === file.count, `${name} changed case inventory for ${file.path}`);
    cases.push(...suites[0].assertionResults.map((item) => ({ ...item, path: file.path })));
  }
  const count = files.reduce((total, item) => total + item.count, 0);
  require(report.numTotalTests === count && cases.length === count, `${name} did not execute all ${count} cases`);
  require(new Set(cases.map((item) => `${item.path}:${item.fullName}`)).size === count, `${name} duplicate case identities`);
  require(cases.every((item) => ["passed", "failed"].includes(item.status)), `${name} skipped cases`);
  require(report.numPendingTests === 0 && report.numTodoTests === 0 && (report.numUnhandledErrors ?? 0) === 0, `${name} pending/todo/unhandled cases`);
  const logs = readFileSync(join(output, `${name}.stdout.txt`), "utf8") + readFileSync(join(output, `${name}.stderr.txt`), "utf8");
  require(!/Unhandled (?:Errors?|Rejection)|Uncaught Exception/i.test(logs), `${name} unhandled runtime error`);
  Object.assign(stages.at(-1), { reportSha256: sha(readFileSync(reportPath)), passed: report.numPassedTests, failed: report.numFailedTests,
    cases: cases.map(({ path, fullName, status }) => ({ path, fullName, status })) }); save();
  return { result, report, cases, count };
}
function green(stage) {
  require(stage.result.status === 0 && stage.report.success === true && stage.report.numPassedTests === stage.count
    && stage.report.numFailedTests === 0 && stage.cases.every((item) => item.status === "passed"), "Candidate suite is not wholly green");
}
function sameCases(a, b) {
  const names = (value) => value.cases.map((item) => `${item.path}:${item.fullName}`).sort();
  require(JSON.stringify(names(a)) === JSON.stringify(names(b)), "Counterfactual/restoration changed case identities");
}
function unitRed(stage) {
  require(stage.result.status === 1 && stage.report.success === false, "Original unit run did not fail normally");
  const reads = stage.cases.filter((item) => item.path === pinned.unitFiles[0].path);
  for (const expected of pinned.unitNegativeSuffixes) {
    const found = reads.filter((item) => item.fullName.endsWith(expected.suffix));
    require(found.length === expected.count && found.every((item) => item.status === "failed" && item.failureMessages?.some((message) => /AssertionError/.test(message))),
      `Missing named unit assertion failure: ${expected.suffix}`);
  }
  for (const suffix of pinned.unitControlSuffixes) {
    const found = reads.filter((item) => item.fullName.endsWith(suffix));
    require(found.length === 1 && found[0].status === "passed", `Unchanged read control failed: ${suffix}`);
  }
  const compatibility = stage.cases.filter((item) => item.path === pinned.unitFiles[1].path);
  require(compatibility.length === 67 && compatibility.every((item) => item.status === "passed"), "Original #281 compatibility controls failed");
}
function browserRed(stage) {
  require(stage.result.status === 1 && stage.report.success === false, "Original browser run did not fail normally");
  const negatives = new Set();
  for (const expected of pinned.browserNegativeAssertions) {
    const found = stage.cases.filter((item) => item.path === expected.path && item.fullName === expected.fullName);
    require(found.length === 1 && found[0].status === "failed", `Missing exact browser negative: ${expected.fullName}`);
    const messages = found[0].failureMessages?.join("\n") ?? "";
    require(messages.includes(`${expected.path}:${expected.line}:`) && /AssertionError/.test(messages), `Negative failed outside frozen assertion: ${expected.fullName}`);
    const plain = messages.replace(/\x1b\[[0-9;]*m/g, "");
    const expectedNumber = expected.expected === 0 ? "\\+?0" : String(expected.expected);
    const reason = new RegExp(`expected ${expected.received} to be ${expectedNumber}(?=\\s|$|/)`);
    require(reason.test(plain), `Wrong assertion reason: ${expected.fullName}`);
    negatives.add(`${expected.path}:${expected.fullName}`);
  }
  const initial = pinned.browserReadInitialCountAssertion;
  const initialFailures = stage.cases.filter((item) => item.path === initial.path);
  require(initialFailures.length === initial.count, "Initial-count browser inventory changed");
  for (const item of initialFailures) {
    const messages = item.failureMessages?.join("\n") ?? "";
    require(item.status === "failed" && messages.startsWith(`${initial.failureFirstLine}\n`)
      && messages.includes(initial.pollStackMarker) && messages.includes(`${initial.path}:${initial.line}:`),
    "Original read browser failure was not the exact known Vitest poll zero-count assertion");
    negatives.add(`${item.path}:${item.fullName}`);
  }
  require(stage.report.numFailedTests === pinned.limits.originalBrowserExpectedFailed
    && stage.report.numPassedTests === pinned.limits.originalBrowserExpectedPassed, "Original browser failures exceeded named expected regressions");
  require(stage.cases.every((item) => negatives.has(`${item.path}:${item.fullName}`) ? item.status === "failed" : item.status === "passed"), "Unchanged browser control failed");
}
function hashTree(directory) {
  const files = [];
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), stat = lstatSync(full);
      require(!stat.isSymbolicLink(), "Symlink in server-bundle evidence refused");
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) files.push({ path: relative(directory, full).replaceAll("\\", "/"), bytes: stat.size, sha256: sha(readFileSync(full)) });
    }
  };
  walk(directory);
  return { files, treeSha256: sha(Buffer.from(JSON.stringify(files))) };
}
function evidence(phase) {
  const recorded = [];
  for (const scene of pinned.candidateEvidenceScenes) for (const width of pinned.candidateEvidenceWidths) {
    const prefix = `.patient-lab-read-proof-results/${phase}-ui/${scene}-${width}`;
    const image = bytes(`${prefix}.png`), bounds = bytes(`${prefix}-bounds.json`);
    require(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Evidence is not a native PNG");
    require(image.readUInt32BE(16) === width && image.readUInt32BE(20) === 1000, "Native viewport image dimensions differ");
    const data = JSON.parse(bounds.toString("utf8"));
    require(data.phase === phase && data.width === width && data.scene === scene, "Geometry identity differs");
    recorded.push({ path: `${prefix}.png`, bytes: image.length, sha256: sha(image) }, { path: `${prefix}-bounds.json`, bytes: bounds.length, sha256: sha(bounds) });
  }
  const statusDir = join(output, `${phase}-status-ui`); mkdirSync(statusDir, { recursive: true });
  for (const name of pinned.statusEvidenceFiles) {
    const src = `.settings-ui-artifacts/${name}`, data = bytes(src);
    copyFileSync(join(root, src), join(statusDir, name));
    recorded.push({ path: `.patient-lab-read-proof-results/${phase}-status-ui/${name}`, bytes: data.length, sha256: sha(data) });
  }
  write(`${phase}.evidence.json`, { phase, recorded });
}
function buildAndBrowser(phase, version) {
  snapshot(version); guardTarget();
  require(!existsSync(join(root, ".sec-http-state.json")), "Previous HTTP session state was not removed");
  // Clear only explicitly named generated synthetic screenshots, never a directory.
  for (const name of pinned.statusEvidenceFiles) {
    const path = join(root, ".settings-ui-artifacts", name);
    if (existsSync(path)) {
      require(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "Unexpected screenshot target type");
      rmSync(path);
    }
  }
  const buildDir = join(root, ".next");
  if (existsSync(buildDir)) require(!lstatSync(buildDir).isSymbolicLink(), "Build directory symlink refused");
  rmSync(buildDir, { recursive: true, force: true });
  require(!existsSync(buildDir), "Prior build was not fully cleared");
  const build = processStage(`build-${phase}`, "npm", ["run", "build"], version, 12 * 60_000, { NODE_ENV: "production" });
  require(build.status === 0, `Fresh build failed: ${phase}`);
  const entry = ".next/standalone/server.js", route = ".next/standalone/.next/server/app/proof-patient-lab-read/page.js";
  require(existsSync(join(root, entry)) && existsSync(join(root, route)), "Fresh standalone server/proof route missing");
  const buildId = bytes(".next/BUILD_ID").toString("utf8").trim();
  require(buildId && bytes(".next/standalone/.next/BUILD_ID").toString("utf8").trim() === buildId, "Standalone BUILD_ID differs");
  const serverTree = hashTree(join(root, ".next/standalone/.next/server"));
  const clientTree = hashTree(join(root, ".next/static"));
  write(`${phase}.build.json`, { phase, version, buildId, source: snapshot(version), standaloneServer: { path: entry, sha256: sha(bytes(entry)) },
    proofRoute: { path: route, sha256: sha(bytes(route)) }, standaloneServerTree: serverTree, staticClientTree: clientTree });
  const regular = testStage(`browser-${phase}`, pinned.browserFiles, version, "vitest.config.security.mts", phase);
  if (version === "candidate") {
    green(regular);
    require(!existsSync(join(root, ".sec-http-state.json")), "Normal browser harness did not clean session state");
    const extra = testStage(`extra-${phase}`, pinned.extraBrowserFiles, version, "vitest.config.security.mts", phase);
    green(extra); evidence(phase);
  }
  require(hashTree(join(root, ".next/standalone/.next/server")).treeSha256 === serverTree.treeSha256, "Executed server bundle changed during browser proof");
  require(hashTree(join(root, ".next/static")).treeSha256 === clientTree.treeSha256
    && hashTree(join(root, ".next/standalone/.next/static")).treeSha256 === clientTree.treeSha256,
  "Served standalone client chunks differ from the freshly built component assets");
  require(!existsSync(join(root, ".sec-http-state.json")), "Browser harness did not remove synthetic session state");
  return regular;
}
const candidateBytes = bytes(component);
const originalRead = spawnSync("git", ["cat-file", "blob", pinned.originalComponent.gitBlob], { cwd: root, timeout: 30_000 });
require(originalRead.status === 0 && !originalRead.error && !originalRead.signal, "Pinned original component unavailable");
const originalBytes = originalRead.stdout;
require(blob(originalBytes) === pinned.originalComponent.gitBlob && sha(originalBytes) === pinned.originalComponent.sha256, "Original component bytes differ");
let failure, beforeUnit, beforeBrowser;
try {
  for (const [name, args] of [["environment-contract", ["run", "verify:environment"]], ["typecheck", ["run", "typecheck"]], ["lint", ["run", "lint"]]]) {
    require(processStage(name, "npm", args, "candidate", 6 * 60_000).status === 0, `${name} failed`);
  }
  beforeUnit = testStage("unit-candidate-before", pinned.unitFiles, "candidate"); green(beforeUnit);
  beforeBrowser = buildAndBrowser("candidate-before", "candidate");
  writeFileSync(join(root, component), originalBytes); snapshot("original");
  const oldUnit = testStage("unit-original", pinned.unitFiles, "original"); sameCases(beforeUnit, oldUnit); unitRed(oldUnit);
  summary.expectedUnitRed = true; save();
  const oldBrowser = buildAndBrowser("original", "original"); sameCases(beforeBrowser, oldBrowser); browserRed(oldBrowser);
  summary.expectedBrowserRed = true; save();
} catch (error) { failure = error; }
finally {
  writeFileSync(join(root, component), candidateBytes);
  try {
    require(blob(bytes(component)) === candidate.gitBlob && sha(bytes(component)) === candidate.sha256, "Byte-exact candidate restore failed");
    snapshot();
    const afterUnit = testStage("unit-candidate-after", pinned.unitFiles, "candidate"); green(afterUnit);
    if (beforeUnit) sameCases(beforeUnit, afterUnit);
    const afterBrowser = buildAndBrowser("candidate-after", "candidate");
    if (beforeBrowser) sameCases(beforeBrowser, afterBrowser);
    summary.sourceAfter = snapshot(); summary.restoredCandidateGreen = true;
  } catch (error) { failure = failure ? new AggregateError([failure, error], "Proof and restoration verification failed") : error; }
  summary.completed = !failure && summary.expectedUnitRed && summary.expectedBrowserRed && summary.restoredCandidateGreen;
  summary.failure = failure ? String(failure) : null; summary.endedAt = now(); save();
}
if (failure) throw failure;
require(summary.completed, "Incomplete counterfactual");
console.log("Exact reviewed component passed focused and real-browser proof; named baseline regressions occurred with unaffected controls; byte-restored candidate passed. Original release CI and Production remain separate gates.");

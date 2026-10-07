import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Temporary owned-CI proof. Never copy this harness or its workflow into a release PR.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, ".patient-lab-query-proof-results");
const manifestPath = ".ci-proof/patient-lab-query/manifest.json";
const manifestSha = "45afece26bf76bda049ed054b58177ea6dda4adc6828025c5354ef26fed84674";
const exactUrl = "postgresql://ci:ci@127.0.0.1:5432/aqlan_p1_test?sslmode=disable";
const testSecret = "ci-placeholder-secret-0123456789abcdef";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const require = (ok, message) => { if (!ok) throw new Error(message); };
const now = () => new Date().toISOString();
const bytes = (path) => {
  const full = join(root, path);
  require(lstatSync(full).isFile() && !lstatSync(full).isSymbolicLink(), `Regular source file required: ${path}`);
  require(realpathSync(full) === full, `Symlink source traversal refused: ${path}`);
  return readFileSync(full);
};
const manifestBytes = bytes(manifestPath);
require(sha(manifestBytes) === manifestSha, "Reviewed proof manifest changed");
const pinned = JSON.parse(manifestBytes.toString("utf8"));
const route = pinned.originalRoute.path;
const candidateRoute = pinned.candidateFiles.find((entry) => entry.path === route);
function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  require(result.status === 0 && !result.error && !result.signal, `Read-only Git check failed: ${args.join(" ")}`);
  return result.stdout.trim();
}
function guardEnvironment() {
  require(process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true", "Owned GitHub Actions CI is required");
  require(process.env.GITHUB_REPOSITORY === pinned.repository, "Unexpected proof repository");
  require(process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF === pinned.proofRef, "Only the exact temporary proof push ref is allowed");
  require(process.env.GITHUB_JOB === "patient_lab_query_proof", "Unexpected proof job");
  require(process.env.RUNNER_ENVIRONMENT === "github-hosted", "Only a disposable GitHub-hosted runner is allowed");
  require(process.env.GITHUB_WORKSPACE && realpathSync(process.env.GITHUB_WORKSPACE) === root, "Unexpected checkout root");
  require(process.cwd() === root, "Proof must run from checkout root");
  require(/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? ""), "Immutable event commit is required");
  for (const name of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    require(/^[1-9][0-9]*$/.test(process.env[name] ?? ""), `Missing ${name}`);
  }
  require(!Object.keys(process.env).some((name) => name.startsWith("RAILWAY_")), "Railway environment refused");
  for (const name of ["POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING", "SOURCE_DATABASE_URL",
    "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "USE_LOCAL_DB", "NODE_OPTIONS"]) {
    require(process.env[name] === undefined, `Alternate connection/runtime setting refused: ${name}`);
  }
  require(process.env.DATABASE_URL === exactUrl && process.env.TEST_DATABASE_URL === exactUrl, "Only the exact loopback disposable PostgreSQL service URL is allowed");
  require(process.env.DATABASE_ENVIRONMENT === "test", "Explicit test database classification required");
  require(process.env.NODE_ENV === undefined || process.env.NODE_ENV === "test", "Production parent environment refused");
  require(process.env.SESSION_SECRET === testSecret, "Only the public CI test secret is allowed");
  require(process.env.CLINIC_TIME_ZONE === "Asia/Aden" && process.env.SECURITY_HTTP_PORT === "3217", "Unexpected isolated harness settings");
}
function sourceSnapshot(routeVersion = "candidate") {
  guardEnvironment();
  require(git("rev-parse", "HEAD") === process.env.GITHUB_SHA, "Checkout differs from the event commit");
  require(git("rev-list", "--parents", "-n", "1", "HEAD") === `${process.env.GITHUB_SHA} ${pinned.baseCommit}`, "Proof must have exactly the pinned actual-main commit as its sole parent");
  require(git("rev-parse", `${pinned.baseCommit}^{tree}`) === pinned.baseTree, "Actual-main base tree changed");
  const expected = [...pinned.candidateFiles.map((entry) => entry.path), ...pinned.proofOnlyFiles].sort();
  const changed = git("diff", "--name-only", pinned.baseCommit, "HEAD", "--").split("\n").filter(Boolean).sort();
  require(JSON.stringify(changed) === JSON.stringify(expected), "Proof commit changed files outside the frozen five-file candidate and three proof files");
  require(git("diff", "--cached", "--name-only") === "", "Index mutation refused");
  const workingChanged = git("diff", "--name-only", "HEAD", "--").split("\n").filter(Boolean);
  require(JSON.stringify(workingChanged) === JSON.stringify(routeVersion === "original" ? [route] : []), "Unexpected tracked source mutation");
  const files = pinned.candidateFiles.map((entry) => {
    const data = bytes(entry.path);
    const original = routeVersion === "original" && entry.path === route;
    require(blob(data) === (original ? pinned.originalRoute.gitBlob : entry.git_blob_sha), `Source blob differs: ${entry.path}`);
    require(sha(data) === (original ? pinned.originalRoute.sha256 : entry.sha256), `Source SHA256 differs: ${entry.path}`);
    if (!original) require(data.length === entry.bytes, `Source byte count differs: ${entry.path}`);
    return { path: entry.path, bytes: data.length, sha256: sha(data), gitBlob: blob(data) };
  });
  for (const entry of pinned.protectedBaseFiles) {
    require(git("rev-parse", `${pinned.baseCommit}:${entry.path}`) === entry.git_blob_sha, `Pinned base object differs: ${entry.path}`);
    require(blob(bytes(entry.path)) === entry.git_blob_sha, `Protected base source changed: ${entry.path}`);
  }
  require(sha(bytes(manifestPath)) === manifestSha, "Proof manifest changed during execution");
  for (const path of pinned.proofOnlyFiles) require(git("hash-object", path) === git("rev-parse", `HEAD:${path}`), `Proof source changed: ${path}`);
  return { routeVersion, files, protectedBaseFiles: pinned.protectedBaseFiles, checkedAt: now() };
}
function write(name, value) { writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`); }
const firstSnapshot = sourceSnapshot();
mkdirSync(output, { recursive: true });
const identity = {
  repository: pinned.repository, ref: pinned.proofRef, eventSha: process.env.GITHUB_SHA,
  proofTree: git("rev-parse", "HEAD^{tree}"), baseCommit: pinned.baseCommit, baseTree: pinned.baseTree,
  runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB,
  manifestSha256: manifestSha, clinicalManifestSha256: pinned.clinicalManifestSha256, nodeVersion: process.version,
  source: firstSnapshot, proofFiles: pinned.proofOnlyFiles.map((path) => ({ path, sha256: sha(bytes(path)), gitBlob: blob(bytes(path)) })),
  safeTargets: { hostname: "127.0.0.1", port: 5432, databases: ["aqlan_p1_test", "aqlan_sec_http"], postgresMajor: 18 },
  scope: "Temporary synthetic query proof only; not release CI or Production verification", startedAt: now(),
};
if (process.argv[2] === "preflight") {
  write("preflight.json", identity);
  console.log("Pinned source and disposable owned-CI environment validated before installation.");
  process.exit(0);
}
require(process.argv[2] === "run", "Only preflight or run is supported");
write("identity.json", identity);
const { validatePostgresTestTarget } = await import(pathToFileURL(join(root, "__tests__/postgres/_safe-target.ts")).href);
function guardTarget() {
  guardEnvironment();
  const target = validatePostgresTestTarget(process.env);
  require(target.testUrl.toString() === exactUrl, "Canonical test-target guard chose a different target");
}
guardTarget();
write("target-guard.json", { canonicalGuard: "__tests__/postgres/_safe-target.ts", exactLoopbackOnly: true, checkedAt: now() });
const commonEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  CI: "true", GITHUB_ACTIONS: "true", DATABASE_ENVIRONMENT: "test", DATABASE_URL: exactUrl, TEST_DATABASE_URL: exactUrl,
  SESSION_SECRET: testSecret, CLINIC_TIME_ZONE: "Asia/Aden", SECURITY_HTTP_PORT: "3217",
  NEXT_TELEMETRY_DISABLED: "1", TZ: "UTC", NO_COLOR: "1",
};
const stages = [];
const summary = { ...identity, stages, completed: false, failure: null };
const save = () => write("summary.json", summary);
save();
function runProcess(name, command, args, routeVersion, timeout, nodeEnv = "test") {
  guardTarget();
  const source = sourceSnapshot(routeVersion);
  const stdout = openSync(join(output, `${name}.stdout.txt`), "w");
  const stderr = openSync(join(output, `${name}.stderr.txt`), "w");
  let result;
  const startedAt = now();
  try {
    result = spawnSync(command, args, { cwd: root, env: { ...commonEnv, NODE_ENV: nodeEnv },
      stdio: ["ignore", stdout, stderr], timeout, killSignal: "SIGKILL" });
  } finally { closeSync(stdout); closeSync(stderr); }
  const record = { name, command: [command, ...args], source, startedAt, endedAt: now(),
    status: result.status, signal: result.signal, error: result.error ? String(result.error) : null,
    stdoutSha256: sha(readFileSync(join(output, `${name}.stdout.txt`))), stderrSha256: sha(readFileSync(join(output, `${name}.stderr.txt`))) };
  write(`${name}.process.json`, record);
  stages.push(record); save();
  sourceSnapshot(routeVersion);
  require(!result.signal && !result.error, `${name} did not complete normally`);
  return result;
}
function testStage(name, testPath, config, routeVersion, count) {
  const reportPath = join(output, `${name}.json`);
  require(!existsSync(reportPath), `Stale report refused: ${name}`);
  const args = ["node_modules/vitest/vitest.mjs", "run", ...(config ? ["--config", config] : []), testPath,
    "--reporter=json", `--outputFile=${reportPath}`];
  const result = runProcess(name, process.execPath, args, routeVersion, 8 * 60_000);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const cases = report.testResults.flatMap((suite) => suite.assertionResults);
  require(report.testResults.length === 1 && report.testResults[0].name.replaceAll("\\", "/").endsWith(`/${testPath}`), `${name} ran an unexpected test file`);
  require(report.numTotalTests === count && cases.length === count, `${name} did not execute all ${count} cases`);
  require(new Set(cases.map((item) => item.fullName)).size === count, `${name} has duplicate case identities`);
  require(cases.every((item) => ["passed", "failed"].includes(item.status)), `${name} skipped or omitted cases`);
  require(report.numPendingTests === 0 && report.numTodoTests === 0, `${name} has pending or todo tests`);
  require((report.numUnhandledErrors ?? 0) === 0, `${name} reports unhandled errors`);
  const rawOutput = readFileSync(join(output, `${name}.stdout.txt`), "utf8") + readFileSync(join(output, `${name}.stderr.txt`), "utf8");
  require(!/Unhandled (?:Errors?|Rejection)|Uncaught Exception/i.test(rawOutput), `${name} contains an unhandled runtime error`);
  const stage = stages.at(-1);
  Object.assign(stage, { reportSha256: sha(readFileSync(reportPath)), passed: report.numPassedTests,
    failed: report.numFailedTests, cases: cases.map(({ fullName, status }) => ({ fullName, status })) });
  save();
  return { result, report, cases };
}
function requireGreen(stage, count) {
  require(stage.result.status === 0 && stage.report.success === true, "Focused candidate suite did not pass");
  require(stage.report.numPassedTests === count && stage.report.numFailedTests === 0
    && stage.cases.every((item) => item.status === "passed"), "Focused candidate has nonpassing cases");
}
function hashTree(directory) {
  const result = [];
  const walk = (path) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), stat = lstatSync(full);
      require(!stat.isSymbolicLink(), "Symlink in built-server evidence refused");
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) result.push({ path: relative(directory, full).replaceAll("\\", "/"), bytes: stat.size, sha256: sha(readFileSync(full)) });
    }
  };
  walk(directory);
  return { files: result, treeSha256: sha(Buffer.from(JSON.stringify(result))) };
}
function buildAndHttp(phase, routeVersion) {
  guardTarget();
  sourceSnapshot(routeVersion);
  require(!existsSync(join(root, ".sec-http-state.json")), "Previous HTTP harness did not remove its session state");
  const buildDir = join(root, ".next");
  if (existsSync(buildDir)) require(!lstatSync(buildDir).isSymbolicLink(), "Build directory symlink refused");
  rmSync(buildDir, { recursive: true, force: true });
  require(!existsSync(buildDir), "Previous build was not fully cleared");
  const build = runProcess(`build-${phase}`, "npm", ["run", "build"], routeVersion, 12 * 60_000, "production");
  require(build.status === 0, `Clean build failed: ${phase}`);
  const serverEntry = ".next/standalone/server.js";
  const builtRoute = ".next/standalone/.next/server/app/api/lab/route.js";
  require(existsSync(join(root, serverEntry)) && existsSync(join(root, builtRoute)), "Fresh standalone server or lab route bundle is missing");
  const buildId = readFileSync(join(root, ".next/BUILD_ID"), "utf8").trim();
  require(buildId.length > 0, "Fresh BUILD_ID is missing");
  require(readFileSync(join(root, ".next/standalone/.next/BUILD_ID"), "utf8").trim() === buildId, "Standalone BUILD_ID differs");
  const builtTree = hashTree(join(root, ".next/standalone/.next/server"));
  write(`${phase}.build.json`, { phase, buildId, routeVersion, source: sourceSnapshot(routeVersion),
    serverEntry: { path: serverEntry, sha256: sha(bytes(serverEntry)) },
    labRouteBundle: { path: builtRoute, sha256: sha(bytes(builtRoute)) }, standaloneServerTree: builtTree,
    buildProcessSha256: sha(readFileSync(join(output, `build-${phase}.process.json`))), capturedAt: now() });
  const http = testStage(`http-${phase}`, pinned.negativeAssertion.path, "vitest.config.security.mts", routeVersion, pinned.expectedCounts.http);
  require(sha(bytes(serverEntry)) === JSON.parse(readFileSync(join(output, `${phase}.build.json`), "utf8")).serverEntry.sha256, "Executed standalone entry changed");
  require(hashTree(join(root, ".next/standalone/.next/server")).treeSha256 === builtTree.treeSha256, "Executed standalone server tree changed during HTTP proof");
  require(!existsSync(join(root, ".sec-http-state.json")), "HTTP harness session-state cleanup failed");
  return http;
}
const candidateBytes = bytes(route);
const originalRead = spawnSync("git", ["cat-file", "blob", pinned.originalRoute.gitBlob], { cwd: root, timeout: 30_000 });
require(originalRead.status === 0 && !originalRead.error && !originalRead.signal, "Pinned original route object unavailable");
const originalBytes = originalRead.stdout;
require(blob(originalBytes) === pinned.originalRoute.gitBlob && sha(originalBytes) === pinned.originalRoute.sha256, "Original route bytes do not match pinned provenance");
require(bytes(pinned.negativeAssertion.path).toString("utf8").split("\n")[pinned.negativeAssertion.line - 1].trim() === pinned.negativeAssertion.statement, "Counterfactual assertion source moved");
let failure;
try {
  const unit = testStage("unit", "__tests__/patient-lab-query-route.test.ts", null, "candidate", pinned.expectedCounts.unit);
  requireGreen(unit, pinned.expectedCounts.unit);
  const postgres = testStage("postgres", "__tests__/postgres/patient-lab-query.test.ts", "vitest.config.postgres.mts", "candidate", pinned.expectedCounts.postgres);
  requireGreen(postgres, pinned.expectedCounts.postgres);
  const before = buildAndHttp("candidate-before", "candidate");
  requireGreen(before, pinned.expectedCounts.http);
  writeFileSync(join(root, route), originalBytes);
  sourceSnapshot("original");
  const original = buildAndHttp("original", "original");
  require(original.result.status === 1 && original.report.success === false, "Original route did not fail normally");
  require(original.report.numFailedTests === 1 && original.report.numPassedTests === pinned.expectedCounts.http - 1, "Original route failed outside the exact expected regression");
  require(JSON.stringify(original.cases.map((item) => item.fullName).sort()) === JSON.stringify(before.cases.map((item) => item.fullName).sort()), "Counterfactual case identities changed");
  const negative = original.cases.find((item) => item.fullName === pinned.negativeAssertion.fullName);
  require(negative?.status === "failed" && negative.failureMessages?.length === 1, "Expected older-target test did not fail once");
  const message = negative.failureMessages[0];
  require(/AssertionError: expected \[\] to deeply equal \[/.test(message), "Negative result was not missing target IDs");
  require(message.includes(`${pinned.negativeAssertion.path}:${pinned.negativeAssertion.line}:`), "Failure did not originate at the pinned target-ID assertion");
  require(original.cases.filter((item) => item !== negative).every((item) => item.status === "passed"), "Unchanged HTTP controls failed");
  summary.expectedRed = { fullName: negative.fullName, assertion: pinned.negativeAssertion, failureMessages: negative.failureMessages };
  save();
} catch (error) { failure = error; }
finally {
  writeFileSync(join(root, route), candidateBytes);
  try {
    require(blob(bytes(route)) === candidateRoute.git_blob_sha, "Byte-exact candidate restore failed");
    const after = buildAndHttp("candidate-after", "candidate");
    requireGreen(after, pinned.expectedCounts.http);
    const beforeStage = stages.find((stage) => stage.name === "http-candidate-before");
    if (beforeStage?.cases) require(JSON.stringify(after.cases.map((item) => item.fullName).sort())
      === JSON.stringify(beforeStage.cases.map((item) => item.fullName).sort()), "Restored candidate case identities changed");
    summary.sourceAfter = sourceSnapshot();
    summary.restoredCandidateGreen = true;
  } catch (error) { failure = failure ? new AggregateError([failure, error], "Proof and restoration verification failed") : error; }
  summary.completed = !failure;
  summary.failure = failure ? String(failure) : null;
  summary.endedAt = now();
  save();
}
if (failure) throw failure;
console.log("Candidate unit/PG and built HTTP passed; only the exact original-route target-ID assertion failed; a clean byte-restored candidate build passed all HTTP controls.");

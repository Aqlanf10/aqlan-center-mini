/** Sanitized Vitest JSON index. Raw messages/titles/meta are never copied or logged.
 * Locations identify test declarations (includeTaskLocation), not stack frames.
 */
import { appendFileSync, readFileSync, realpathSync, lstatSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const countKeys = ['numFailedTests', 'numFailedTestSuites', 'numPassedTests', 'numPassedTestSuites', 'numPendingTests', 'numPendingTestSuites', 'numTodoTests', 'numTotalTests', 'numTotalTestSuites'];
const bounded = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
function testPath(root, name) {
  if (typeof name !== 'string' || /[\x00-\x1f\x7f\\]/u.test(name) || name.includes('://') || name.split('/').some(p => p === '..' || p === '.')) throw new Error('invalid');
  const full = resolve(root, name), rel = relative(root, full).split(sep).join('/');
  if (isAbsolute(rel) || !/^__tests__\/security-http\/[a-zA-Z0-9_/-]+\.test\.tsx?$/u.test(rel)) throw new Error('invalid');
  if (realpathSync(full) !== full || !lstatSync(full).isFile()) throw new Error('invalid');
  execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, stdio: 'ignore' });
  return rel;
}
export function sanitizeReport(report, projectRoot) {
  const root = realpathSync(projectRoot);
  if (!report || typeof report !== 'object' || !Array.isArray(report.testResults) || report.testResults.length === 0) throw new Error('invalid');
  const counts = {};
  for (const key of countKeys) { if (!bounded(report[key])) throw new Error('invalid'); counts[key] = report[key]; }
  const failures = [];
  for (const suite of report.testResults) {
    const file = testPath(root, suite.name);
    if (!['failed', 'passed'].includes(suite.status) || !Array.isArray(suite.assertionResults)) throw new Error('invalid');
    let found = false;
    for (const result of suite.assertionResults) {
      if (!['failed', 'passed', 'skipped', 'pending', 'todo', 'disabled'].includes(result.status)) throw new Error('invalid');
      if (result.status !== 'failed') continue;
      found = true;
      const loc = result.location;
      if (loc != null && (!bounded(loc.line) || !bounded(loc.column) || loc.line === 0 || loc.column === 0)) throw new Error('invalid');
      // JSON reporter exposes only free-text errors; do not parse those strings.
      failures.push({ file, line: loc?.line ?? null, column: loc?.column ?? null, errorClass: 'UnclassifiedTestError' });
    }
    if (suite.status === 'failed' && !found) failures.push({ file, line: null, column: null, errorClass: 'UnclassifiedSuiteError' });
  }
  return { schemaVersion: 1, status: 'valid', locationKind: 'test-declaration', counts, failures };
}
export function collect(rawFile, outputFile, root) {
  try {
    rmSync(outputFile, { force: true });
    let result, code = 0;
    try {
      const stat = lstatSync(rawFile);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('invalid');
      result = sanitizeReport(JSON.parse(readFileSync(rawFile, 'utf8')), root);
    }
    catch { result = { schemaVersion: 1, status: 'unavailable-or-invalid' }; code = 1; }
    finally {
      try { rmSync(rawFile, { force: true }); }
      catch { result = { schemaVersion: 1, status: 'unavailable-or-invalid' }; code = 1; }
    }
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, JSON.stringify(result) + '\n', { mode: 0o600 });
    return code;
  } finally {
    try { rmSync(rawFile, { force: true }); } catch { /* CLI stays nonzero on I/O failure; never echo paths. */ }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['main', 'inventory'].includes(mode) || !process.env.RUNNER_TEMP) process.exitCode = 1;
  else {
    try {
      process.exitCode = collect(resolve(process.env.RUNNER_TEMP, `http-${mode}-raw.json`), resolve(`.http-failure-index/${mode}.json`), process.cwd());
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "ready=true\n");
    }
    catch { process.exitCode = 1; } // Never echo filesystem errors or paths.
  }
}

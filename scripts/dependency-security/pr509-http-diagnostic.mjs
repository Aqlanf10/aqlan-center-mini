/** Exact synthetic PR509 target only. Never emit raw error text or report metadata. */
import { lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const TARGET = '__tests__/security-http/radiology-request-journey.test.ts';
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const unavailable = { schemaVersion: 1, status: 'unavailable-or-invalid' };
const positive = value => Number.isSafeInteger(value) && value > 0;
function checkedTarget(root) {
  const base = realpathSync(root), full = resolve(base, TARGET);
  if (realpathSync(full) !== full || !lstatSync(full).isFile()) throw new Error('invalid');
  execFileSync('git', ['ls-files', '--error-unmatch', '--', TARGET], { cwd: base, stdio: 'ignore' });
  return { full, lines: readFileSync(full, 'utf8').split('\n').length };
}
function scalar(lines, label) {
  const pattern = new RegExp(`^${label}: (true|false|-?(?:0|[1-9][0-9]{0,9})(?:\\.[0-9]{1,6})?)$`);
  const matches = lines.map(line => pattern.exec(line.trim())).filter(Boolean);
  if (matches.length !== 1) return undefined;
  const token = matches[0][1];
  if (token === 'true' || token === 'false') return token === 'true';
  const value = Number(token);
  return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000 ? value : undefined;
}
export function sanitizeDiagnostic(report, root) {
  const target = checkedTarget(root);
  if (!report || !Array.isArray(report.testResults) || report.testResults.length !== 1) throw new Error('invalid');
  const suite = report.testResults[0];
  if (![TARGET, target.full].includes(suite.name) || !['passed', 'failed'].includes(suite.status) || !Array.isArray(suite.assertionResults) || suite.assertionResults.length > 10000) throw new Error('invalid');
  const failed = suite.assertionResults.filter(result => result?.status === 'failed');
  if (suite.assertionResults.some(result => !['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled'].includes(result?.status))) throw new Error('invalid');
  const failures = failed.slice(0, 10).map(result => {
    if (!Array.isArray(result.failureMessages) || result.failureMessages.length > 10 || result.failureMessages.some(message => typeof message !== 'string' || message.length > 65536)) throw new Error('invalid');
    const messages = result.failureMessages.map(message => message.replace(/\u001b\[[0-9;]*m/g, ''));
    const lines = messages.flatMap(message => message.split('\n'));
    const category = messages.some(message => /^AssertionError:/.test(message)) ? 'AssertionError'
      : messages.some(message => /^TimeoutError:/.test(message)) ? 'TimeoutError'
        : messages.some(message => /^Error:/.test(message)) ? 'Error' : 'Unknown';
    const locations = [];
    for (const line of lines) {
      // Parse a complete location token, then compare exact canonical path;
      // never accept a substring of traversal or a foreign absolute pathname.
      for (const match of line.matchAll(/(?:^|[\s(])([^\s()]+):(\d+):(\d+)(?=$|[\s)])/g)) {
        const [, path, rawLine, rawColumn] = match;
        const lineNumber = Number(rawLine), column = Number(rawColumn);
        if (![TARGET, target.full].includes(path) || !positive(lineNumber) || lineNumber > target.lines || !positive(column) || column > 2000) continue;
        if (!locations.some(location => location.line === lineNumber && location.column === column) && locations.length < 5) locations.push({ file: TARGET, line: lineNumber, column });
      }
    }
    const expected = scalar(lines, 'Expected'), actual = scalar(lines, 'Received');
    return { category, locations, ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) };
  });
  if (suite.status === 'failed' && failed.length === 0) failures.push({ category: 'SuiteError', locations: [] });
  const result = { schemaVersion: 1, status: 'valid', file: TARGET, failedCount: failed.length, omittedFailures: Math.max(0, failed.length - 10), failures };
  if (JSON.stringify(result).length > 12000) throw new Error('invalid');
  return result;
}
export function collectDiagnostic(rawFile, root) {
  let result = unavailable, code = 1;
  try {
    const stat = lstatSync(rawFile);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REPORT_BYTES || realpathSync(rawFile) !== resolve(rawFile)) throw new Error('invalid');
    result = sanitizeDiagnostic(JSON.parse(readFileSync(rawFile, 'utf8')), root); code = 0;
  } catch { /* Constant failure only: no paths, messages or stacks. */ }
  finally { try { rmSync(rawFile, { force: true }); } catch { result = unavailable; code = 1; } }
  return { code, result };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.RUNNER_TEMP) { console.log(JSON.stringify(unavailable)); process.exitCode = 1; }
  else {
    const { code, result } = collectDiagnostic(resolve(process.env.RUNNER_TEMP, 'pr509-http-raw.json'), process.cwd());
    console.log(JSON.stringify(result)); process.exitCode = code;
  }
}

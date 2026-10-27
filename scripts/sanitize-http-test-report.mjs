import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// This is an allowlist projection, never a redaction of diagnostic text.
export const LIMITS = Object.freeze({ rawBytes: 64 * 1024 * 1024, suites: 512, assertions: 10000, path: 240, count: 1000000, failures: 64 });
const statuses = new Set(['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled']);
const kinds = new Set(['AssertionError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'TimeoutError', 'Error']);
const integer = (n) => Number.isSafeInteger(n) && n >= 0 && n <= LIMITS.count ? n : null;
const sourcePath = (p) => typeof p === 'string' && p.length <= LIMITS.path && /^__tests__\/security-http\/[a-zA-Z0-9_./-]+\.test\.ts$/.test(p) && !p.split('/').some((part) => part === '..' || part === '.');
const unavailable = (reason, sourceSha = null) => ({ version: 1, availability: 'unavailable', reason, sourceSha });
const kind = (message) => {
  if (typeof message !== 'string') return 'unknown';
  const candidate = message.slice(0, 32).split(':', 1)[0];
  return kinds.has(candidate) ? candidate : 'unknown';
};

export function sanitizeReport(raw, { root, sourceSha, trackedPaths }) {
  const sha = /^[a-f0-9]{40}$/.test(sourceSha ?? '') ? sourceSha : null;
  if (!sha) return unavailable('source_unavailable');
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validAssertion = (a) => object(a) && typeof a.status === 'string' && (a.failureMessages === null || (Array.isArray(a.failureMessages) && a.failureMessages.every((m) => typeof m === 'string')));
  const validSuite = (s) => object(s) && typeof s.name === 'string' && typeof s.status === 'string' && Array.isArray(s.assertionResults) && s.assertionResults.every(validAssertion);
  if (!object(raw) || !Array.isArray(raw.testResults) || !raw.testResults.every(validSuite)) return unavailable('malformed', sha);
  const allowed = new Set(trackedPaths.filter(sourcePath));
  let remaining = LIMITS.assertions;
  let truncated = raw.testResults.length > LIMITS.suites;
  const suites = [];
  for (const suite of raw.testResults.slice(0, LIMITS.suites)) {
    const relative = typeof suite.name === 'string' ? path.relative(root, path.resolve(root, suite.name)) : '';
    if (!allowed.has(relative)) { truncated = true; continue; }
    const assertions = suite.assertionResults.slice(0, remaining).map((a, index) => ({
      index,
      status: statuses.has(a?.status) ? a.status : 'unknown',
      line: integer(a?.location?.line),
      column: integer(a?.location?.column),
      failureCount: Array.isArray(a?.failureMessages) ? integer(a.failureMessages.length) : null,
      errorKinds: Array.isArray(a?.failureMessages) ? [...new Set(a.failureMessages.slice(0, LIMITS.failures).map(kind))] : [],
    }));
    if (assertions.length < suite.assertionResults.length || suite.assertionResults.some((a) => Array.isArray(a?.failureMessages) && a.failureMessages.length > LIMITS.failures)) truncated = true;
    remaining -= assertions.length;
    suites.push({ path: relative, status: statuses.has(suite.status) ? suite.status : 'unknown', assertionCount: integer(suite.assertionResults.length), assertions });
  }
  return { version: 1, availability: 'available', sourceSha: sha, truncated, suiteCount: integer(raw.testResults.length), suites };
}

export function readDiagnostic(rawPath, options) {
  options = { ...options, sourceSha: /^[a-f0-9]{40}$/.test(options.sourceSha ?? '') ? options.sourceSha : null };
  let size;
  try { size = statSync(rawPath).size; } catch { return unavailable('missing', options.sourceSha); }
  if (size > LIMITS.rawBytes) return unavailable('oversized', options.sourceSha);
  try { return sanitizeReport(JSON.parse(readFileSync(rawPath, 'utf8')), options); }
  catch { return unavailable('malformed', options.sourceSha); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let result = unavailable('source_unavailable');
  try {
    const root = process.cwd();
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const trackedPaths = execFileSync('git', ['ls-files', '-z', '--', '__tests__/security-http'], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0');
    result = readDiagnostic(process.argv[2], { root, sourceSha, trackedPaths });
  } catch { /* No raw command errors, paths, or environment values are emitted. */ }
  // Explicit destination only; failures remain failures rather than being suppressed.
  writeFileSync(process.argv[3], `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
}

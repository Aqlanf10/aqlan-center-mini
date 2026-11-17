import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Revalidate the sanitized document: never print arbitrary fields, exception text,
// source excerpts or paths that are not tracked HTTP test source files.
const MAX_BYTES = 8 * 1024 * 1024, MAX_SUITES = 512, MAX_ASSERTIONS = 10000, MAX_ANNOTATIONS = 20, MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const sourcePath = value => typeof value === 'string' && value.length <= 240
  && /^__tests__\/security-http\/[a-zA-Z0-9_./-]+\.test\.ts$/.test(value)
  && !value.split('/').some(part => part === '.' || part === '..');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? String(value) : 'unknown';

// Fixed words and bounded numbers only. Never echo report fields as text: even
// malformed documents and malicious reasons produce one safe diagnostic.
export function summaryFromSanitized(report, sourceSha, outcome) {
  const step = ['success', 'failure', 'cancelled', 'skipped'].includes(outcome) ? outcome : 'unknown';
  const prefix = `::notice::HTTP diagnostics: step=${step}; `;
  if (!record(report) || report.version !== 1) return `${prefix}unavailable (invalid report)`;
  if (report.availability === 'unavailable') {
    const reason = ['missing', 'oversized', 'malformed', 'source_unavailable'].includes(report.reason) ? report.reason : 'unknown';
    return `${prefix}unavailable (${reason})`;
  }
  if (report.availability !== 'available' || !/^[a-f0-9]{40}$/.test(sourceSha ?? '') || report.sourceSha !== sourceSha || !Array.isArray(report.suites) || report.suites.length > MAX_SUITES)
    return `${prefix}unavailable (untrusted report)`;
  const values = record(report.counts) ? report.counts : {};
  const success = values.success === true ? 'true' : values.success === false ? 'false' : 'unknown';
  const projectedFailed = report.suites.filter(suite => record(suite) && suite.status === 'failed').length;
  return `${prefix}report_success=${success}; suites=${count(values.totalSuites)}; failed_suites=${count(values.failedSuites)}; tests=${count(values.totalTests)}; failed_tests=${count(values.failedTests)}; projected_failed_suites=${count(projectedFailed)}; truncated=${report.truncated === true ? 'true' : report.truncated === false ? 'false' : 'unknown'}`;
}

export function annotationsFromSanitized(report, { sourceSha, trackedPaths, sourceLineCount }) {
  if (!record(report) || report.version !== 1 || report.availability !== 'available'
      || !/^[a-f0-9]{40}$/.test(sourceSha ?? '') || report.sourceSha !== sourceSha
      || !Array.isArray(trackedPaths) || !Array.isArray(report.suites) || report.suites.length > MAX_SUITES) return [];
  const allowed = new Set(trackedPaths.filter(sourcePath));
  const out = [], seen = new Set(), lineCounts = new Map();
  let examined = 0;
  function add(source, line) {
    if (!allowed.has(source)) return;
    let lines = lineCounts.get(source);
    if (lines === undefined) {
      try { lines = sourceLineCount(source); } catch { lines = null; }
      lineCounts.set(source, lines);
    }
    if (!Number.isSafeInteger(lines) || lines < 1 || lines > 1000000) return;
    const validLine = Number.isSafeInteger(line) && line >= 1 && line <= lines ? line : null;
    const key = `${source}:${validLine ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(`::error file=${source}${validLine === null ? '' : `,line=${validLine}`}::HTTP test failed (sanitized location)`);
  }
  for (const suite of report.suites) {
    if (out.length >= MAX_ANNOTATIONS) break;
    if (!record(suite) || !allowed.has(suite.path) || suite.status !== 'failed' || !Array.isArray(suite.assertions)) continue;
    let emitted = out.length;
    for (const assertion of suite.assertions) {
      if (++examined > MAX_ASSERTIONS || out.length >= MAX_ANNOTATIONS) break;
      if (!record(assertion) || assertion.status !== 'failed') continue;
      const frame = Array.isArray(assertion.failureFrames) ? assertion.failureFrames.slice(0, 8).find(f => record(f) && allowed.has(f.path)
        && Number.isSafeInteger(f.line) && f.line > 0) : undefined;
      add(frame?.path ?? suite.path, frame?.line ?? assertion.line);
    }
    // A beforeAll or suite-load failure can have no failed assertion.
    if (out.length === emitted && out.length < MAX_ANNOTATIONS) add(suite.path, null);
    if (examined > MAX_ASSERTIONS) break;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('invalid arguments');
    const root = realpathSync(process.cwd()), file = process.argv[2];
    const size = statSync(file).size;
    if (size > MAX_BYTES) throw new Error('invalid report');
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const trackedPaths = execFileSync('git', ['ls-files', '-z', '--', '__tests__/security-http'], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0');
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const sourceLineCount = source => {
      const absolute = path.resolve(root, source), stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES || !realpathSync(absolute).startsWith(`${root}${path.sep}`)) throw new Error('invalid source');
      return readFileSync(absolute, 'utf8').split('\n').length;
    };
    console.log(summaryFromSanitized(report, sourceSha, process.env.HTTP_TEST_OUTCOME));
    for (const line of annotationsFromSanitized(report, { sourceSha, trackedPaths, sourceLineCount })) console.log(line);
  } catch { console.log('::notice::HTTP diagnostics: unavailable (unreadable report)'); }
}

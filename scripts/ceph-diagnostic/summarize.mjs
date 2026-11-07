import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const allowed = JSON.parse(readFileSync(new URL('./test-names.json', import.meta.url), 'utf8'));
const states = new Set(['passed', 'failed', 'pending', 'skipped', 'todo']);
// Never emit raw error messages, stacks, paths, URLs, environment or payloads.
// Fixed categories and bounded numeric assertion differences are sufficient to
// distinguish geometry regressions, selector timeouts and browser setup failures.
export function classify(value) {
  const text = String(value || '').slice(0, 32000).replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(line => !/^\s+at /.test(line)).join('\n');
  const categories = [];
  for (const [pattern, label] of [
    [/strict mode violation/i, 'ambiguous-selector'], [/Timeout|timed out/i, 'timeout'],
    [/browserType\.launch|Executable doesn.t exist/i, 'browser-launch'],
    [/EPERM|Operation not permitted/i, 'runtime-permission'], [/ENOSPC|no space left/i, 'disk-space'],
    [/Could not resolve|Build failed/i, 'fixture-build'], [/toBeCloseTo/, 'coordinate-assertion'],
    [/toEqual|deeply equal/, 'equality-assertion'], [/toBeGreaterThan/, 'size-assertion'],
    [/toBe|AssertionError/, 'assertion'], [/Target .*closed|context.*closed/i, 'browser-closed'],
  ]) if (pattern.test(text)) categories.push(label);
  const numeric = [];
  for (const line of text.split('\n')) {
    if (line.trim().length <= 80 && /^(Expected|Received):\s*(?:[<>]=?\s*)?(?:-?\d+(?:\.\d+)?|true|false|null)\s*$/.test(line.trim())) numeric.push(line.trim());
    if (numeric.length === 4) break;
  }
  const comparison = text.match(/expected (-?\d{1,8}(?:\.\d{1,6})?|true|false|null) to (?:be|equal) (-?\d{1,8}(?:\.\d{1,6})?|true|false|null)(?=\s|$)/i);
  if (!numeric.length && comparison) numeric.push('Expected: ' + comparison[2], 'Received: ' + comparison[1]);
  const selectors = ['ceph-viewport', 'ceph-surface', 'ceph-image', 'ceph-loupe', 'ceph-loupe-scene', 'ceph-overlay'].filter(name => text.includes(name));
  return { categories: categories.length ? categories : ['unclassified-error'], numeric, selectors };
}
export function summarize(raw) {
  const result = { schema: 1, scope: 'synthetic-ceph-browser-only', report: 'available', tests: [], suiteErrors: [] };
  const rows = Array.isArray(raw?.testResults) ? raw.testResults.slice(0, 4) : [];
  for (const suite of rows) {
    if (!String(suite.name || '').replaceAll('\\', '/').endsWith('/__tests__/security-http/ceph-tracer-real-react.test.ts')) continue;
    if (suite.message) result.suiteErrors.push(classify(suite.message));
    for (const item of (suite.assertionResults || []).slice(0, 64)) {
      if (!allowed.includes(item.title) || result.tests.some(t => t.name === item.title)) continue;
      result.tests.push({ name: item.title, status: states.has(item.status) ? item.status : 'unknown', errors: (Array.isArray(item.failureMessages) ? item.failureMessages : []).slice(0, 2).map(classify) });
    }
  }
  result.suiteErrors = result.suiteErrors.slice(0, 2);
  if (!result.tests.length && !result.suiteErrors.length) result.report = 'no-allowlisted-results';
  return result;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , source, destination] = process.argv;
  let report;
  try {
    const bytes = readFileSync(source);
    if (bytes.length > 2 * 1024 * 1024) throw new Error('oversized');
    report = summarize(JSON.parse(bytes.toString('utf8')));
  } catch { report = { schema: 1, scope: 'synthetic-ceph-browser-only', report: 'missing-or-invalid', tests: [], suiteErrors: [] }; }
  const statuses = new Set(['success', 'failure', 'cancelled', 'skipped']);
  report.steps = Object.fromEntries(['install', 'chromium', 'tests'].map(name => [name, statuses.has(process.env['CEPH_STEP_' + name.toUpperCase()]) ? process.env['CEPH_STEP_' + name.toUpperCase()] : 'unknown']));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
}

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LIMITS, readDiagnostic, sanitizeReport } from '../scripts/sanitize-http-test-report.mjs';

const source = '__tests__/security-http/security.test.ts';
const options = { root: '/repo', sourceSha: 'a'.repeat(40), trackedPaths: [source] };
const secret = 'PRIVATE_cookie_token_patient_body_stdout';
const report = () => ({ testResults: [{ name: `/repo/${source}`, status: 'failed', message: secret, assertionResults: [{ title: secret, fullName: secret, ancestorTitles: [secret], status: 'failed', failureMessages: [`AssertionError: ${secret}\n at ${secret}:1:2`], location: { line: 12, column: 3 }, meta: { secret }, stdout: secret, actual: secret, expected: secret }] }], coverageMap: secret, snapshot: secret });
const temporary = [];
afterEach(() => temporary.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
const temp = () => { const p = mkdtempSync(path.join(tmpdir(), 'http-sanitizer-')); temporary.push(p); return p; };

describe('HTTP diagnostic allowlist', () => {
  it('emits only source provenance, indices, statuses, bounded locations/counts and fixed kinds', () => {
    const output = sanitizeReport(report(), options);
    expect(output).toEqual({ version: 1, availability: 'available', sourceSha: options.sourceSha, truncated: false, suiteCount: 1, suites: [{ path: source, status: 'failed', assertionCount: 1, assertions: [{ index: 0, status: 'failed', line: 12, column: 3, failureCount: 1, errorKinds: ['AssertionError'] }] }] });
    expect(JSON.stringify(output)).not.toContain(secret);
  });
  it('rejects untracked, traversal, non-test and oversized paths without echoing them', () => {
    for (const name of [`/repo/${secret}.test.ts`, `/repo/../${source}`, '/etc/passwd', `${source}${secret}`, 'a'.repeat(1000)]) {
      const raw = report(); raw.testResults[0].name = name;
      expect(sanitizeReport(raw, options).suites).toEqual([]);
    }
  });
  it('does not echo arbitrary statuses, error classes, or invalid numeric metadata', () => {
    const raw = report(); const suite = raw.testResults[0]; const assertion = suite.assertionResults[0];
    suite.status = secret; assertion.status = secret;
    assertion.failureMessages = [`${secret}: sensitive`, `TypeError: ${secret}`];
    assertion.location = { line: secret, column: LIMITS.count + 1 };
    const output = sanitizeReport(raw, options);
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(output.suites[0].assertions[0]).toMatchObject({ status: 'unknown', line: null, column: null, errorKinds: ['unknown', 'TypeError'] });
  });
  it('bounds suite/assertion output globally and error-kind inspection', () => {
    const raw = report(); raw.testResults[0].assertionResults = Array(LIMITS.assertions + 1).fill(raw.testResults[0].assertionResults[0]);
    raw.testResults = Array(LIMITS.suites + 1).fill(raw.testResults[0]);
    const output = sanitizeReport(raw, options);
    expect(output.truncated).toBe(true);
    expect(output.suites).toHaveLength(LIMITS.suites);
    expect(output.suites.reduce((n, s) => n + s.assertions.length, 0)).toBe(LIMITS.assertions);
    expect(JSON.stringify(output).length).toBeLessThan(2000000);
    const small = report(); small.testResults[0].assertionResults[0].failureMessages = Array(LIMITS.failures + 1).fill(secret);
    expect(sanitizeReport(small, options).truncated).toBe(true);
  });
  it('reports missing, malformed, oversized and unavailable provenance safely, never success', () => {
    const file = path.join(temp(), 'raw.json');
    expect(readDiagnostic(file, options).reason).toBe('missing');
    writeFileSync(file, secret); expect(readDiagnostic(file, options).reason).toBe('malformed');
    writeFileSync(file, '{}'); expect(readDiagnostic(file, options).reason).toBe('malformed');
    truncateSync(file, LIMITS.rawBytes + 1); expect(readDiagnostic(file, options).reason).toBe('oversized');
    expect(JSON.stringify(readDiagnostic(file, { ...options, sourceSha: secret }))).not.toContain(secret);
    expect(sanitizeReport(report(), { ...options, sourceSha: secret })).toEqual({ version: 1, availability: 'unavailable', reason: 'source_unavailable', sourceSha: null });
  });
  it('marks structurally malformed suite/assertion entries unavailable', () => {
    for (const raw of [{ testResults: [{ assertionResults: [] }] }, { testResults: [null] }, { testResults: [{ name: source, status: 'failed', assertionResults: [null] }] }, { testResults: [{ name: source, status: 'failed', assertionResults: [{ status: 'failed', failureMessages: [123] }] }] }]) {
      expect(sanitizeReport(raw, options)).toMatchObject({ availability: 'unavailable', reason: 'malformed' });
    }
  });
  it('uploads only exact sanitized files after unchanged failing test commands', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    for (const lane of ['security', 'inventory']) {
      expect(workflow).toContain(`--reporter=default --reporter=json --outputFile.json=\${{ runner.temp }}/http-${lane}-raw.json --includeTaskLocation`);
      expect(workflow).toContain(`path: \${{ runner.temp }}/http-${lane}-locations.json\n          if-no-files-found: error\n          retention-days: 7`);
      expect(workflow).not.toContain(`path: \${{ runner.temp }}/http-${lane}-raw.json`);
    }
  });
});

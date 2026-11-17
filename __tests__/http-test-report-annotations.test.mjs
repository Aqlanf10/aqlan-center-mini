import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { annotationsFromSanitized } from '../scripts/annotate-http-test-report.mjs';
import { sanitizeReport } from '../scripts/sanitize-http-test-report.mjs';

const source = '__tests__/security-http/accountant-readonly-ui-journey.test.ts';
const secret = 'PRIVATE_PATIENT_TOKEN_::error file=leak';
const options = { sourceSha: 'a'.repeat(40), trackedPaths: [source], sourceLineCount: () => 100 };
const valid = () => ({ version: 1, availability: 'available', sourceSha: options.sourceSha,
  suites: [{ path: source, status: 'failed', assertions: [{ status: 'failed', line: 12, failureFrames: [{ path: source, line: 23 }] }] }] });

describe('sanitized HTTP annotations', () => {
  it('emits tracked failure frame locations only and never emits raw fields', () => {
    const input = valid(); input.secret = secret; input.suites[0].assertions[0].failureMessages = [secret];
    const result = annotationsFromSanitized(input, options);
    expect(result).toEqual([`::error file=${source},line=23::HTTP test failed (sanitized location)`]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('projects an actual raw failure through the sanitizer before emitting fixed annotations', () => {
    const raw = { testResults: [{ name: `/repo/${source}`, status: 'failed', message: secret,
      assertionResults: [{ status: 'failed', title: secret, location: {line: 12, column: 2},
        failureMessages: [`AssertionError: ${secret}\n    at /repo/${source}:23:2`] }] }] };
    const sanitized = sanitizeReport(raw, {root:'/repo', sourceSha:options.sourceSha, trackedPaths:[source]});
    const result = annotationsFromSanitized(sanitized, options);
    expect(result).toEqual([`::error file=${source},line=23::HTTP test failed (sanitized location)`]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('handles setup failures and invalid or out-of-range locations without printing supplied values', () => {
    for (const bad of [0, -1, 1.5, 101, secret, Number.MAX_SAFE_INTEGER]) {
      const input = valid(); input.suites[0].assertions = [{ status: 'failed', line: bad, failureFrames: [] }];
      expect(annotationsFromSanitized(input, options)).toEqual([`::error file=${source}::HTTP test failed (sanitized location)`]);
    }
    const setup = valid(); setup.suites[0].assertions = [{ status: 'skipped', line: 5 }];
    expect(annotationsFromSanitized(setup, options)).toEqual([`::error file=${source}::HTTP test failed (sanitized location)`]);
  });
  it('rejects malicious paths, unavailable reports, untrusted provenance and statuses', () => {
    for (const bad of [`../${source}`, `${source},line=1::${secret}`, `https://evil/${source}`, `${source}\n${secret}`]) {
      const input = valid(); input.suites[0].path = bad;
      expect(annotationsFromSanitized(input, { ...options, trackedPaths: [bad] })).toEqual([]);
    }
    for (const mutation of [r => r.sourceSha = secret, r => r.availability = 'unavailable', r => r.suites[0].status = secret, r => r.version = 2]) {
      const input = valid(); mutation(input); expect(annotationsFromSanitized(input, options)).toEqual([]);
    }
    const input = valid(); input.suites[0].assertions[0].failureFrames = [{ path: `${source}::${secret}`, line: 1 }];
    expect(annotationsFromSanitized(input, options)).toEqual([`::error file=${source},line=12::HTTP test failed (sanitized location)`]);
  });
  it('bounds output and source reads, ignores duplicate failures and cannot use inaccessible sources', () => {
    let reads = 0; const input = valid();
    input.suites[0].assertions = Array.from({ length: 300 }, (_, i) => ({status: 'failed', line: i + 1, failureFrames: []}));
    const result = annotationsFromSanitized(input, { ...options, sourceLineCount: () => { reads++; return 1000; } });
    expect(result).toHaveLength(20); expect(reads).toBe(1);
    expect(annotationsFromSanitized(input, { ...options, sourceLineCount: () => { throw new Error(secret); } })).toEqual([]);
  });
  it('CLI consumes only sanitized JSON and silently refuses malformed or missing files', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'safe-http-annotations-'));
    try {
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const file = path.join(directory, 'sanitized.json'); const input = valid(); input.sourceSha = sha;
      writeFileSync(file, JSON.stringify(input));
      const run = target => execFileSync(process.execPath, ['scripts/annotate-http-test-report.mjs', target], { encoding: 'utf8' });
      expect(run(file)).toContain('::error file=__tests__/security-http/accountant-readonly-ui-journey.test.ts');
      writeFileSync(file, secret); expect(run(file)).toBe(''); expect(run(path.join(directory, 'missing'))).toBe('');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('runs only after sanitization, with no raw report or test-status override', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    for (const lane of ['security', 'inventory']) {
      const sanitized = `scripts/sanitize-http-test-report.mjs "\${{ runner.temp }}/http-${lane}-raw.json" "\${{ runner.temp }}/http-${lane}-locations.json"`;
      const annotated = `scripts/annotate-http-test-report.mjs "\${{ runner.temp }}/http-${lane}-locations.json"`;
      expect(workflow.indexOf(sanitized)).toBeGreaterThan(-1);
      expect(workflow.indexOf(annotated)).toBeGreaterThan(workflow.indexOf(sanitized));
      expect(workflow).not.toContain(`scripts/annotate-http-test-report.mjs "\${{ runner.temp }}/http-${lane}-raw.json"`);
    }
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);
  });
});

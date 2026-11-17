import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { annotationsFromSanitized, summaryFromSanitized } from '../scripts/annotate-http-test-report.mjs';
import { sanitizeReport } from '../scripts/sanitize-http-test-report.mjs';

const source = '__tests__/security-http/accountant-readonly-ui-journey.test.ts';
const secret = 'PRIVATE_PATIENT_TOKEN_::error file=leak';
const options = { sourceSha: 'a'.repeat(40), trackedPaths: [source], sourceLineCount: () => 100 };
const valid = () => ({ version: 1, availability: 'available', sourceSha: options.sourceSha,
  suites: [{ path: source, status: 'failed', assertions: [{ status: 'failed', line: 12, failureFrames: [{ path: source, line: 23 }] }] }] });

describe('sanitized HTTP annotations', () => {
  it('reports only validated counters even when raw fields contain secrets or forged workflow commands', () => {
    const input = valid(); input.truncated = false;
    input.counts = { success: false, totalSuites: 7, failedSuites: 1, totalTests: 13, failedTests: 2, injected: secret };
    expect(summaryFromSanitized(input, options.sourceSha, 'failure')).toBe('::notice::HTTP diagnostics: step=failure; report_success=false; suites=7; failed_suites=1; tests=13; failed_tests=2; projected_failed_suites=1; truncated=false');
    input.counts = { success: secret, totalSuites: secret, failedSuites: -1, totalTests: Infinity, failedTests: 1000001 };
    const result = summaryFromSanitized(input, options.sourceSha);
    expect(result).toContain('report_success=unknown; suites=unknown; failed_suites=unknown; tests=unknown; failed_tests=unknown');
    expect(result).not.toContain(secret);
    expect(summaryFromSanitized({ version: 1, availability: 'unavailable', reason: secret }, options.sourceSha, secret)).toBe('::notice::HTTP diagnostics: step=unknown; unavailable (unknown)');
    expect(summaryFromSanitized({ ...input, sourceSha: secret }, options.sourceSha)).toBe('::notice::HTTP diagnostics: step=unknown; unavailable (untrusted report)');
  });
  it('preserves actual Vitest aggregate counts and distinguishes a failed run with no failed assertions', () => {
    const raw = { success: false, numTotalTestSuites: 1, numFailedTestSuites: 0, numTotalTests: 1, numFailedTests: 0,
      testResults: [{ name: `/repo/${source}`, status: 'passed', assertionResults: [{ status: 'passed', failureMessages: [] }] }] };
    const safe = sanitizeReport(raw, {root:'/repo', sourceSha:options.sourceSha, trackedPaths:[source]});
    expect(summaryFromSanitized(safe, options.sourceSha)).toContain('report_success=false; suites=1; failed_suites=0; tests=1; failed_tests=0; projected_failed_suites=0');
    expect(annotationsFromSanitized(safe, options)).toEqual([]);
  });
  it('projects a real synthetic Vitest JSON report without exposing its test title or error text', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'safe-http-real-vitest-'));
    try {
      const relative = '__tests__/security-http/synthetic.test.ts';
      mkdirSync(path.join(directory, '__tests__/security-http'), { recursive: true });
      symlinkSync(realpathSync('node_modules'), path.join(directory, 'node_modules'), 'dir');
      writeFileSync(path.join(directory, relative), `import {it,expect} from 'vitest'; it(${JSON.stringify(secret)},()=>expect(1).toBe(2));`);
      const output = path.join(directory, 'result.json');
      const run = spawnSync(process.execPath, [realpathSync('node_modules/vitest/vitest.mjs'), 'run', '--root', directory, '--reporter=json', '--includeTaskLocation', '--outputFile', output], { encoding: 'utf8', timeout: 30000 });
      expect(run.status).toBe(1);
      const raw = JSON.parse(readFileSync(output, 'utf8'));
      const safe = sanitizeReport(raw, {root:directory, sourceSha:options.sourceSha, trackedPaths:[relative]});
      expect(safe.counts).toMatchObject({ success:false, totalSuites:1, failedSuites:1, totalTests:1, failedTests:1 });
      expect(annotationsFromSanitized(safe, { ...options, trackedPaths:[relative] })).toHaveLength(1);
      expect(JSON.stringify(safe)).not.toContain(secret);
      writeFileSync(path.join(directory, relative), `import {it} from 'vitest'; it('synthetic unhandled',async()=>{setTimeout(()=>{throw new Error(${JSON.stringify(secret)})},1); await new Promise(r=>setTimeout(r,20))});`);
      const unhandled = spawnSync(process.execPath, [realpathSync('node_modules/vitest/vitest.mjs'), 'run', '--root', directory, '--reporter=json', '--includeTaskLocation', '--outputFile', output], { encoding: 'utf8', timeout: 30000 });
      expect(unhandled.status).toBe(1);
      const rawUnhandled = JSON.parse(readFileSync(output, 'utf8'));
      const safeUnhandled = sanitizeReport(rawUnhandled, {root:directory, sourceSha:options.sourceSha, trackedPaths:[relative]});
      // Vitest 4.1.12 can exit nonzero for an unhandled error while its JSON
      // success bit and failed counters still describe only the passed tests.
      expect(safeUnhandled.counts).toMatchObject({ success:true, failedSuites:0, failedTests:0 });
      expect(summaryFromSanitized(safeUnhandled, options.sourceSha, 'failure')).toContain('step=failure; report_success=true; suites=1; failed_suites=0; tests=1; failed_tests=0');
      expect(JSON.stringify(safeUnhandled)).not.toContain(secret);
    } finally { rmSync(directory, { recursive:true, force:true }); }
  }, 45000);
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
      writeFileSync(file, secret); expect(run(file)).toBe('::notice::HTTP diagnostics: unavailable (unreadable report)\n'); expect(run(path.join(directory, 'missing'))).toBe('::notice::HTTP diagnostics: unavailable (unreadable report)\n');
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
      expect(workflow).toContain(`HTTP_TEST_OUTCOME: \${{ steps.http_${lane}_tests.outcome }}`);
    }
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);
  });
});

import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { TARGET, MAX_REPORT_BYTES, sanitizeDiagnostic, collectDiagnostic } from '../scripts/dependency-security/pr509-http-diagnostic.mjs';
const source = readFileSync(resolve('.github/workflows/pr509-radiology-http-diagnostic.yml'), 'utf8');
const root = process.cwd();
const temp: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), 'pr509-diagnostic-')); temp.push(path); return path; };
afterEach(() => { for (const path of temp.splice(0)) rmSync(path, { recursive: true, force: true }); });
const report = (message = `AssertionError: private\nExpected: 0\nReceived: 2\n ❯ assertQuiet ${TARGET}:120:7`) => ({ testResults: [{ name: resolve(TARGET), status: 'failed', assertionResults: [{ status: 'failed', title: 'SECRET PATIENT', failureMessages: [message], meta: { token: 'SECRET TOKEN' } }] }] });
it('retains only fixed category, exact assertion locations and strict scalar values', () => {
  expect(sanitizeDiagnostic(report(), root)).toMatchObject({ status: 'valid', failures: [{ category: 'AssertionError', locations: [{ file: TARGET, line: 120, column: 7 }], expected: 0, actual: 2 }] });
  expect(sanitizeDiagnostic(report(`Error: private\nExpected: true\nReceived: false\n at fn (${resolve(TARGET)}:125:3)`), root).failures[0]).toEqual({ category: 'Error', locations: [{ file: TARGET, line: 125, column: 3 }], expected: true, actual: false });
});
it('never exposes arbitrary titles, tokens, cookies, HTML, SQL, URL, ANSI or raw error text', () => {
  const payload = 'PHI-PATIENT token=SECRET Authorization: Bearer SECRET Cookie: SESSION https://private.invalid <html>PRIVATE</html> SELECT password FROM users';
  const result = sanitizeDiagnostic(report(`\u001b[31mAssertionError: ${payload}\u001b[0m\nExpected: "${payload}"\nReceived: ${payload}\n at f (${TARGET}:121:1)`), root);
  const output = JSON.stringify(result);
  for (const forbidden of ['PHI-PATIENT', 'SECRET', 'SESSION', 'private.invalid', '<html>', 'SELECT', '\u001b', 'failureMessages', 'title', 'meta']) expect(output).not.toContain(forbidden);
  expect(result.failures[0]).toEqual({ category: 'AssertionError', locations: [{ file: TARGET, line: 121, column: 1 }] });
});
it.each(['1e3', 'NaN', 'Infinity', '"42"', '42 pixels', '12345678901', '1000000001', '01', '1.1234567', 'true secret'])('omits uncertain scalar grammar %s', value => {
  const failure = sanitizeDiagnostic(report(`AssertionError: private\nExpected: ${value}\nReceived: ${value}`), root).failures[0];
  expect(failure).not.toHaveProperty('expected'); expect(failure).not.toHaveProperty('actual');
});
it('rejects foreign absolute paths/traversal and limits stack line/column to target source', () => {
  const result = sanitizeDiagnostic(report(`AssertionError: private\n at /foreign/${TARGET}:12:4\n at ../${TARGET}:12:4\n at ${TARGET}:999999:1\n at ${TARGET}:1:2001\n at ${TARGET}:0:1\n at ${TARGET}:12:4`), root);
  expect(result.failures[0].locations).toEqual([{ file: TARGET, line: 12, column: 4 }]);
  const bad = report(); bad.testResults[0].name = `../${TARGET}`; expect(() => sanitizeDiagnostic(bad, root)).toThrow();
});
it('bounds failures, locations and message length without exposing raw data', () => {
  const message = 'TimeoutError: private\n' + Array.from({ length: 12 }, (_, i) => ` at ${TARGET}:${i + 1}:1`).join('\n');
  const many = report(message); many.testResults[0].assertionResults = Array.from({ length: 14 }, () => many.testResults[0].assertionResults[0]);
  const result = sanitizeDiagnostic(many, root); expect(result.failures).toHaveLength(10); expect(result.omittedFailures).toBe(4);
  expect(result.failures.every(failure => failure.locations.length === 5)).toBe(true); expect(JSON.stringify(result).length).toBeLessThanOrEqual(12000);
  expect(() => sanitizeDiagnostic(report('x'.repeat(65537)), root)).toThrow();
});
it('fails closed and deletes malformed/oversize raw reports; rejects symlinks without reading targets', () => {
  const directory = dir(), raw = join(directory, 'raw.json');
  for (const content of ['not JSON', '{}']) { writeFileSync(raw, content); expect(collectDiagnostic(raw, root)).toEqual({ code: 1, result: { schemaVersion: 1, status: 'unavailable-or-invalid' } }); expect(existsSync(raw)).toBe(false); }
  writeFileSync(raw, ''); truncateSync(raw, MAX_REPORT_BYTES + 1); expect(collectDiagnostic(raw, root).code).toBe(1); expect(existsSync(raw)).toBe(false);
  const secret = join(directory, 'secret'); writeFileSync(secret, 'SECRET'); symlinkSync(secret, raw);
  expect(collectDiagnostic(raw, root).code).toBe(1); expect(existsSync(raw)).toBe(false); expect(readFileSync(secret, 'utf8')).toBe('SECRET');
  writeFileSync(raw, JSON.stringify(report())); expect(collectDiagnostic(raw, root).code).toBe(0); expect(existsSync(raw)).toBe(false);
});
it('rejects a symlinked target rather than trusting a source-name alias', () => {
  const fakeRoot = dir(); symlinkSync(join(root, '__tests__'), join(fakeRoot, '__tests__'));
  expect(() => sanitizeDiagnostic(report(), fakeRoot)).toThrow();
});
it('contains diagnostic to exact same-repository PR509 event head and one synthetic test', () => {
  for (const gate of ["github.repository == 'Aqlanf10/aqlan-center-mini'", 'github.event.pull_request.number == 509', "github.event.pull_request.base.ref == 'main'", "github.event.pull_request.head.repo.full_name == 'Aqlanf10/aqlan-center-mini'", "github.event.pull_request.head.ref == 'feat/radiology-requests-20261101'"]) expect(source).toContain(gate);
  expect(source).toContain('permissions:\n  contents: read'); expect(source).toContain('ref: ${{ github.event.pull_request.head.sha }}\n          persist-credentials: false');
  expect(source).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD"');
  expect(source).toContain('image: postgres:18-alpine'); expect(source).toContain('node-version: 22'); expect(source).toContain('run: npm run build');
  expect(source).not.toMatch(/pull_request_target|workflow_dispatch|secrets\.|vars\.|continue-on-error|upload-artifact|download-artifact|--retry|testNamePattern|passWithNoTests/);
  expect(source.match(/__tests__\/security-http\/[\w-]+\.test\.ts/g)).toEqual([TARGET]);
});
it.each([[42, 0, 42], [124, 0, 124], [0, 1, 1], [0, 0, 0]])('preserves test/timeout failure and fails closed on collector failure (%i,%i)', (testCode, collectorCode, expectedCode) => {
  const shell = source.split('        run: |\n').at(-1)!.split('\n').map(line => line.slice(10)).join('\n');
  expect(spawnSync('bash', ['-n'], { input: shell }).status).toBe(0);
  const directory = dir();
  const functions = `timeout() { printf 'SECRET RAW OUTPUT'; return ${testCode}; }; node() { return ${collectorCode}; };\n`;
  const result = spawnSync('bash', ['-c', functions + shell], { env: { NODE_ENV: "test", PATH: process.env.PATH, RUNNER_TEMP: directory }, encoding: 'utf8' });
  expect(result.status).toBe(expectedCode); expect(result.stdout + result.stderr).not.toContain('SECRET'); expect(existsSync(join(directory, 'pr509-legacy-http-raw.log'))).toBe(false);
});

it.each([['404','200',404,200],['true','false',true,false],['1.5','2.25',1.5,2.25]])('maps inline actual then expected scalars only (%s,%s)',(actual,expected,a,e)=>{
  expect(sanitizeDiagnostic(report(`AssertionError: expected ${actual} to be ${expected} // Object.is equality`),root).failures[0]).toMatchObject({actual:a,expected:e});
});
it.each(['AssertionError: expected "404" to be 200','AssertionError: expected 404 to be 200 SECRET','PREFIX AssertionError: expected 404 to be 200','AssertionError: expected 1e3 to be 200','AssertionError: expected 1000000001 to be 200','AssertionError: expected 404 to be\n200','AssertionError: expected 404 to be 200\u001b]SECRET'])('omits unsupported inline scalar forms',message=>{
 const failure=sanitizeDiagnostic(report(message),root).failures[0];expect(failure).not.toHaveProperty('actual');expect(failure).not.toHaveProperty('expected');
});
it('classifies exact page goto timeout without retaining timeout or call log',()=>{
 expect(sanitizeDiagnostic(report('page.goto: Timeout 30000ms exceeded.\nCall log:\n https://secret.invalid/?token=SECRET'),root).failures[0]).toEqual({category:'TimeoutError',locations:[]});
 for(const message of ['PREFIX page.goto: Timeout 30000ms exceeded.','page.goto: Timeout 30000ms exceeded. SECRET','page.goto: Timeout 9999999999ms exceeded.'])expect(sanitizeDiagnostic(report(message),root).failures[0].category).toBe('Unknown');
});
it.each([['ERR_CONNECTION_REFUSED','NavigationConnectionRefused'],['ERR_ABORTED','NavigationAborted'],['ERR_CONNECTION_CLOSED','NavigationConnectionClosed'],['ERR_HTTP_RESPONSE_CODE_FAILURE','NavigationHttpResponseFailure']])('maps exact navigation code%s to closed enum only',(code,category)=>{
 const result=sanitizeDiagnostic(report(`page.goto: net::${code} at https://SECRET:PRIVATE@secret.invalid/path?token=TOKEN\nCall log:\n Cookie: COOKIE`),root);
 expect(result.failures[0]).toEqual({category,locations:[]});
 for(const secret of ['SECRET','PRIVATE','secret.invalid','TOKEN','COOKIE','https','Call log'])expect(JSON.stringify(result)).not.toContain(secret);
});
it.each(['page.goto: net::ERR_UNKNOWN at https://private.invalid','PREFIX page.goto: net::ERR_ABORTED at https://private.invalid','page.goto: net::ERR_ABORTED at https://private.invalid SECRET','page.goto: net::ERR_ABORTED_EXTRA at https://private.invalid','page.goto: net::ERR_ABORTED at not-a-url'])('omits unsupported navigation forms',message=>{
 expect(sanitizeDiagnostic(report(message),root).failures[0]).toEqual({category:'Unknown',locations:[]});
});

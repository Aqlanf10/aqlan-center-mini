import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sanitizeReport, collect } from '../scripts/dependency-security/http-failure-index.mjs';
let root;
const file = '__tests__/security-http/synthetic.test.ts';
const secret = 'DO-NOT-EMIT-private-token https://private.invalid/patient';
function report() {
  return { numFailedTests: 1, numFailedTestSuites: 1, numPassedTests: 0, numPassedTestSuites: 0,
    numPendingTests: 0, numPendingTestSuites: 0, numTodoTests: 0, numTotalTests: 1, numTotalTestSuites: 1,
    stdout: secret, env: secret, testResults: [{ name: join(root, file), status: 'failed', message: secret,
      assertionResults: [{ status: 'failed', location: { line: 12, column: 3 }, title: secret,
        fullName: secret, ancestorTitles: [secret], failureMessages: [secret], meta: { secret }, expected: secret, actual: secret }] }] };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'http-index-'));
  mkdirSync(join(root, '__tests__/security-http'), { recursive: true });
  writeFileSync(join(root, file), '// synthetic');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '--', file], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('emits only allowlisted fields; absolute input becomes canonical tracked relative output', () => {
  const result = sanitizeReport(report(), root);
  expect(result.failures).toEqual([{ file, line: 12, column: 3, errorClass: 'UnclassifiedTestError' }]);
  expect(Object.keys(result).sort()).toEqual(['counts', 'failures', 'locationKind', 'schemaVersion', 'status']);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(root);
});
it('accepts clean report and emits no failures', () => {
  const r = report(); r.numFailedTests = r.numFailedTestSuites = 0; r.numPassedTests = r.numPassedTestSuites = 1;
  r.testResults[0].status = r.testResults[0].assertionResults[0].status = 'passed';
  expect(sanitizeReport(r, root).failures).toEqual([]);
});
it.each(['../outside.test.ts', '/tmp/outside.test.ts', '__tests__/security-http/../security-http/synthetic.test.ts',
  './__tests__/security-http/synthetic.test.ts', 'file:///private', 'https://private', '__tests__/security-http/synthetic.test.ts\nprivate',
  'C:\\private\\test.ts', '__tests__/security-http/missing.test.ts', 'package.json'])('rejects unsafe or untracked path %s', name => {
  const r = report(); r.testResults[0].name = name; expect(() => sanitizeReport(r, root)).toThrow();
});
it('rejects symlinks even when tracked', () => {
  const link = '__tests__/security-http/link.test.ts'; symlinkSync(join(root, file), join(root, link));
  execFileSync('git', ['add', '--', link], { cwd: root });
  const r = report(); r.testResults[0].name = link; expect(() => sanitizeReport(r, root)).toThrow();
});
it.each([-1, 1.2, 1000001, '1', Infinity])('rejects malformed counts %s', n => {
  const r = report(); r.numFailedTests = n; expect(() => sanitizeReport(r, root)).toThrow();
});
it.each([{ line: -1, column: 2 }, { line: 1, column: secret }, { line: 1000001, column: 2 }])('rejects malformed location %j', loc => {
  const r = report(); r.testResults[0].assertionResults[0].location = loc; expect(() => sanitizeReport(r, root)).toThrow();
});
it('classifies suite-only failure without copying its message', () => {
  const r = report(); r.testResults[0].assertionResults = [];
  expect(sanitizeReport(r, root).failures).toEqual([{ file, line: null, column: null, errorClass: 'UnclassifiedSuiteError' }]);
});
it.each(['bad JSON ' + secret, '{}', '{"testResults":[]}', null])('malformed or missing raw result yields only constant diagnostic and deletes raw', raw => {
  const input = join(root, 'raw.json'), output = join(root, 'index.json');
  if (raw !== null) writeFileSync(input, raw);
  expect(collect(input, output, root)).toBe(1);
  expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ schemaVersion: 1, status: 'unavailable-or-invalid' });
  expect(existsSync(input)).toBe(false);
});
it('collects valid report then deletes raw private metadata', () => {
  const input = join(root, 'raw.json'), output = join(root, 'index.json'); writeFileSync(input, JSON.stringify(report()));
  expect(collect(input, output, root)).toBe(0); expect(existsSync(input)).toBe(false);
  expect(readFileSync(output, 'utf8')).not.toContain(secret);
});
it('workflow keeps original test command status and only uploads exact sanitized paths', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  for (const mode of ['main', 'inventory']) {
    // Integration: the normal suite is sharded across two runners; inventory runs whole in each.
    const command = `npm run test:security-http -- --reporter=default --reporter=json --includeTaskLocation --outputFile.json="$RUNNER_TEMP/http-${mode}-raw.json"${mode === "main" ? " --shard=${{ matrix.shard }}/2" : ""}`;
    expect(workflow).toContain(`run: ${command}`);
    // Actual command body run with a shell-function double: arbitrary nonzero exit survives.
    const result = spawnSync('bash', ['-c', `npm() { return 37; }; ${command.replace('${{ matrix.shard }}', '1')}`], { env: { PATH: process.env.PATH, RUNNER_TEMP: root } });
    expect(result.status).toBe(37);
    expect(workflow).toContain(`path: .http-failure-index/${mode}.json\n          if-no-files-found: error`);
    expect(workflow).toContain(`if: always()\n        run: node scripts/dependency-security/http-failure-index.mjs ${mode}`);
  }
  expect(workflow).not.toMatch(/path:.*raw\.json/);
  expect(workflow).toContain('timeout-minutes: 75');
});
it('roundtrips actual installed Vitest JSON with failing and skipped tests without exposing raw metadata', () => {
  const vitest = resolve('node_modules/vitest/vitest.mjs');
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, file), `import { it, describe } from 'vitest';\nit('private title must not leak', () => { throw new Error('private assertion must not leak'); });\ndescribe.skip('private skipped suite', () => { it('private skipped test', () => {}); });\n`);
  const skipped = '__tests__/security-http/skipped.test.ts';
  writeFileSync(join(root, skipped), "import { it } from 'vitest'; it.skip('private fully skipped file', () => {});\n");
  execFileSync('git', ['add', '--', skipped], { cwd: root });
  const config = join(root, 'vitest.config.mjs');
  writeFileSync(config, 'export default { test: { include: ["__tests__/security-http/*.test.ts"] } };\n');
  const raw = join(root, 'raw.json');
  const result = spawnSync(process.execPath, [vitest, 'run', '--root', root, '--config', config,
    '--reporter=default', '--reporter=json', '--includeTaskLocation', `--outputFile.json=${raw}`],
  { cwd: root, encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
  expect(result.status).toBe(1);
  expect(existsSync(raw)).toBe(true);
  const output = join(root, 'index.json'); expect(collect(raw, output, root)).toBe(0);
  const clean = JSON.parse(readFileSync(output, 'utf8'));
  expect(clean.counts.numFailedTests).toBe(1); expect(clean.counts.numPendingTests).toBe(2);
  expect(clean.failures).toEqual([{ file, line: 2, column: 1, errorClass: 'UnclassifiedTestError' }]);
  expect(JSON.stringify(clean)).not.toContain('private'); expect(existsSync(raw)).toBe(false);
}, 35000);
it('CLI does not expose filesystem errors or signal upload readiness on output I/O failure', () => {
  const output = join(root, '.http-failure-index'); mkdirSync(output);
  mkdirSync(join(output, 'main.json')); writeFileSync(join(output, 'main.json', 'blocker'), 'synthetic');
  const raw = join(root, 'http-main-raw.json'); writeFileSync(raw, JSON.stringify(report()));
  const githubOutput = join(root, 'github-output');
  const result = spawnSync(process.execPath, [resolve('scripts/dependency-security/http-failure-index.mjs'), 'main'],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: root, GITHUB_OUTPUT: githubOutput } });
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  expect(existsSync(githubOutput)).toBe(false); expect(existsSync(raw)).toBe(false);
});

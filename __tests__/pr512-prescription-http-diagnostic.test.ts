import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
const source = readFileSync(resolve('.github/workflows/pr512-prescription-http-diagnostic.yml'), 'utf8');
it('restricts diagnosis to exact same-repository PR512 and branch without elevated access', () => {
  expect(source).toContain('pull_request:\n    branches: [main]\n    types: [opened, synchronize, reopened]');
  for (const gate of ["github.repository == 'Aqlanf10/aqlan-center-mini'", 'github.event.pull_request.number == 512',
    "github.event.pull_request.base.ref == 'main'", "github.event.pull_request.head.repo.full_name == 'Aqlanf10/aqlan-center-mini'",
    "github.event.pull_request.head.ref == 'feat/rx-dose-profiles-20261101'"]) expect(source).toContain(gate);
  expect(source).toContain('permissions:\n  contents: read');
  expect(source).toContain('ref: ${{ github.event.pull_request.head.sha }}\n          persist-credentials: false');
  expect(source).toContain('timeout-minutes: 45');
  expect(source).toContain('group: pr512-prescription-http-${{ github.event.pull_request.number }}\n  cancel-in-progress: true');
  expect(source).not.toMatch(/pull_request_target|workflow_dispatch|secrets\.|vars\.|continue-on-error|upload-artifact|download-artifact|packages:|id-token:|environment:|docker (?:push|login)|^ {2}push:/m);
});
it('uses existing supported build and isolated PG18 contract', () => {
  for (const value of ['image: postgres:18-alpine', 'node-version: 22', 'npm install -g npm@11.21.1',
    'run: npm ci', 'run: npm run verify:environment', 'run: npm run build', 'npx playwright install --with-deps chromium',
    'postgresql://ci:ci@127.0.0.1:5432/aqlan_p1_test?sslmode=disable', 'CLINIC_TIME_ZONE: Asia/Aden']) expect(source).toContain(value);
});
it('executes exactly the three requested test files without altering original nonzero status', () => {
  const command = source.match(/run: >-\n([\s\S]*?)$/)![1].trim().split('\n').map(line => line.trim()).join(' ');
  expect(command).toBe('npm run test:security-http -- __tests__/security-http/prescription-diagnosis-ui.test.ts __tests__/security-http/prescription-reprint-journey.test.ts __tests__/security-http/legacy-patient-context-ui.test.ts');
  expect(spawnSync('bash', ['-c', `npm() { return 42; }; ${command}`]).status).toBe(42);
  expect(source).not.toMatch(/testNamePattern|--bail|--passWithNoTests|\|\| true|--retry/);
});
it('validates head via environment only, rejecting malformed identity before git', () => {
  const shell = source.match(/run: \|\n([\s\S]*?)\n {6}- name: Verify environment/)![1].split('\n').map(line => line.slice(10)).join('\n');
  expect(shell).not.toContain('${{'); expect(shell).toContain('^[0-9a-f]{40}$');
  expect(spawnSync('bash', ['-n'], { input: shell }).status).toBe(0);
  expect(spawnSync('bash', ['-c', shell], { env: { NODE_ENV: "test", PATH: process.env.PATH, EXPECTED_HEAD: 'invalid\nmetadata' } }).status).not.toBe(0);
});

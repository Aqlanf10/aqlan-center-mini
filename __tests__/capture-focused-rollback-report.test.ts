import { constants } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  files: new Map<string, string>(), writes: [] as { path: string; data: string }[],
  databases: [] as { name: string; oid: string; owner: string; owned: boolean }[],
  clients: 0, connections: 0, endings: 0, closedFiles: 0, badDirectory: false,
  connectionFails: false, endingFails: false,
}));

vi.mock('node:fs/promises', () => ({
  realpath: async (value: string) => value,
  readdir: async (value: string) => value === '/tmp/synthetic-runner'
    ? ['hr-composed-legacy-restore-12345-1-Ab12Cd']
    : [...fake.files.keys()].filter(key => key.startsWith(`${value}/`)).map(key => key.slice(value.length + 1)),
  lstat: async (value: string) => ({
    isFile: () => fake.files.has(value), isDirectory: () => value.endsWith('Ab12Cd'),
    isSymbolicLink: () => fake.badDirectory && value.endsWith('Ab12Cd'), nlink: 1,
    size: fake.files.get(value)?.length ?? 0, uid: process.getuid?.(),
  }),
  open: async (value: string, flags: number) => {
    if ((flags & constants.O_NOFOLLOW) === 0) throw new Error('synthetic-unsafe-open');
    const content = fake.files.get(value);
    if (content === undefined) throw new Error('synthetic-file-missing');
    return {
      stat: async () => ({ isFile: () => true, nlink: 1, size: content.length, uid: process.getuid?.() }),
      readFile: async () => content,
      close: async () => { fake.closedFiles++; },
    };
  },
  writeFile: async (value: string, data: string, options: { flag: string }) => {
    if (options.flag !== 'wx' || fake.files.has(value)) throw new Error('synthetic-overwrite-refused');
    fake.writes.push({ path: value, data }); fake.files.set(value, data);
  },
}));

vi.mock('pg', () => ({
  Client: class {
    constructor() { fake.clients++; }
    async connect() { fake.connections++; if (fake.connectionFails) throw new Error('synthetic-connect-failure'); }
    async end() { fake.endings++; if (fake.endingFails) throw new Error('synthetic-end-failure'); }
    async query(sql: string) {
      if (sql.includes('server_version_num')) return { rows: [{ database: 'aqlan_p1_test', user: 'ci', version: '180000' }] };
      if (sql.includes('FROM pg_database')) return { rows: fake.databases };
      throw new Error('Unexpected synthetic SQL');
    }
  },
}));

import { captureFocusedRollbackReport } from './helpers/capture-focused-rollback-report';
import { initialRetainedRollbackReport } from './helpers/retained-rollback-report';

const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'test', GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKSPACE: '/tmp/synthetic-workspace', RUNNER_TEMP: '/tmp/synthetic-runner',
  SYNTHETIC_WITNESS_ROOT: '/tmp/synthetic-runner', SYNTHETIC_LATE_ROLLBACK_WITNESS: '1',
  DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable',
  TEST_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable',
};
const directory = '/tmp/synthetic-runner/hr-composed-legacy-restore-12345-1-Ab12Cd';

beforeEach(() => {
  fake.files.clear(); fake.writes.length = 0; fake.clients = 0; fake.connections = 0; fake.endings = 0; fake.closedFiles = 0;
  fake.badDirectory = false; fake.connectionFails = false; fake.endingFails = false;
  fake.databases = ['a', 'b', 'c'].map((letter, index) => ({ name: `aqlan_backup_precision_${letter.repeat(32)}`, oid: String(100 + index), owner: '10', owned: true }));
  for (const { name, oid, owner } of fake.databases) fake.files.set(`${directory}/identity-${name}.json`, JSON.stringify({ name, oid, owner }));
  fake.files.set(`${directory}/synthetic-rollback-report.json`, JSON.stringify({ ...initialRetainedRollbackReport(), databases: 3,
    identityBefore: true, identityAfter: true, legacySha256: 'a'.repeat(64), faultySha256: 'b'.repeat(64),
    outcome: 'duplicate_constraint', rows: 'unchanged', registry: 'unchanged', patientIdSequence: 'regressed', patientNumberSequence: 'unchanged' }));
});

it('copies only the strictly bounded report after checking all owned identities', async () => {
  await captureFocusedRollbackReport(env);
  expect(fake.connections).toBe(1); expect(fake.endings).toBe(1); expect(fake.writes).toHaveLength(1);
  expect(fake.closedFiles).toBe(4);
  const data = fake.writes[0].data;
  expect(data.includes('regressed')).toBe(true);
  expect(/postgres|password|synthetic-runner|aqlan_backup_precision|\/tmp\//i.test(data)).toBe(false);
});

it('rejects a conflicting alias before constructing any client or output', async () => {
  await expect(captureFocusedRollbackReport({ ...env, POSTGRES_URL: 'postgresql://ci:ci@example.com/other' })).rejects.toThrow();
  expect(fake.clients).toBe(0); expect(fake.writes).toHaveLength(0);
});

it('rejects untrusted report fields and symlinked directories before connection', async () => {
  const path = `${directory}/synthetic-rollback-report.json`;
  fake.files.set(path, JSON.stringify({ ...initialRetainedRollbackReport(), path: 'synthetic-private-marker' }));
  await expect(captureFocusedRollbackReport(env)).rejects.toThrow();
  expect(fake.clients).toBe(0); expect(fake.writes).toHaveLength(0);
  fake.badDirectory = true;
  await expect(captureFocusedRollbackReport(env)).rejects.toThrow();
  expect(fake.clients).toBe(0); expect(fake.writes).toHaveLength(0);
});

it('fails closed when a recorded database identity no longer matches', async () => {
  fake.databases[1].oid = '999';
  await expect(captureFocusedRollbackReport(env)).rejects.toThrow();
  expect(fake.connections).toBe(1); expect(fake.endings).toBe(1); expect(fake.writes).toHaveLength(0);
});

it('closes the client and preserves the connection error without writing, even if close fails', async () => {
  fake.connectionFails = true; fake.endingFails = true;
  await expect(captureFocusedRollbackReport(env)).rejects.toThrow('synthetic-connect-failure');
  expect(fake.connections).toBe(1); expect(fake.endings).toBe(1); expect(fake.writes).toHaveLength(0);
});

it('does not write the report if closing an otherwise successful client fails', async () => {
  fake.endingFails = true;
  await expect(captureFocusedRollbackReport(env)).rejects.toThrow('synthetic-end-failure');
  expect(fake.connections).toBe(1); expect(fake.endings).toBe(1); expect(fake.writes).toHaveLength(0);
});

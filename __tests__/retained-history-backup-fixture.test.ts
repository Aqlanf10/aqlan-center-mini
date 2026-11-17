import { beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  identities: new Map<string, { name: string; oid: string; owner: string }>(),
  queries: [] as string[], clients: 0, closedPools: 0, closedClients: 0,
}));

vi.mock('pg', () => {
  class Client {
    constructor() { fake.clients++; }
    async connect() {}
    async end() { fake.closedClients++; }
    async query(sql: string, params?: unknown[]) {
      fake.queries.push(sql);
      if (sql.includes("current_setting('server_version_num')")) return { rows: [{ version: '180000' }] };
      const create = /^CREATE DATABASE "([a-z0-9_]+)" TEMPLATE template0$/.exec(sql);
      if (create) {
        const name = create[1];
        fake.identities.set(name, { name, oid: String(fake.identities.size + 100), owner: '10' });
        return { rows: [] };
      }
      if (sql.includes('FROM pg_database WHERE datname=$1')) return { rows: [fake.identities.get(String(params?.[0]))] };
      if (/^DROP DATABASE /.test(sql)) return { rows: [] };
      throw new Error('Unexpected synthetic admin SQL');
    }
  }
  class Pool {
    private readonly name: string;
    constructor(options: { connectionString: string }) { this.name = new URL(options.connectionString).pathname.slice(1); }
    async end() { fake.closedPools++; }
    async query(sql: string) {
      fake.queries.push(sql);
      if (sql.includes('datname=current_database()')) return { rows: [fake.identities.get(this.name)] };
      if (sql.includes('FROM pg_class')) return { rows: [{ count: 0 }] };
      throw new Error('Unexpected synthetic pool SQL');
    }
  }
  return { Client, Pool };
});

import { openBackupTimestampFixture } from './postgres/_backup-timestamp-fixture';

const safe: NodeJS.ProcessEnv = {
  NODE_ENV: 'test', GITHUB_ACTIONS: 'true', CI: 'true', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKSPACE: '/tmp/synthetic-workspace', RUNNER_TEMP: '/tmp/synthetic-runner',
  SYNTHETIC_WITNESS_ROOT: '/tmp/synthetic-runner', SYNTHETIC_RESTORE_HISTORY_WITNESS: '1',
  DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable',
  TEST_DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:55473/aqlan_p1_test?sslmode=disable',
};

beforeEach(() => { fake.identities.clear(); fake.queries.length = 0; fake.clients = 0; fake.closedPools = 0; fake.closedClients = 0; });

it('retains each owned database and immutable recorded identity while closing all clients', async () => {
  const recorded: Readonly<{ name: string; oid: string; owner: string }>[] = [];
  const fixture = await openBackupTimestampFixture(safe, { retainOwned: true, onIntent: async () => {}, onOwned: async identity => { recorded.push(identity); } });
  expect(recorded).toHaveLength(3);
  expect(new Set(recorded.map(item => item.name)).size).toBe(3);
  expect(recorded.every(item => Object.isFrozen(item))).toBe(true);
  await fixture.close();
  expect(fake.closedPools).toBe(3);
  expect(fake.closedClients).toBe(1);
  expect(fake.queries.some(sql => /^DROP DATABASE/.test(sql))).toBe(false);
  expect(fake.identities.size).toBe(3);
});

it('does not drop a created database when identity recording fails', async () => {
  await expect(openBackupTimestampFixture(safe, { retainOwned: true, onIntent: async () => {}, onOwned: async () => { throw new Error('synthetic-record-failure'); } })).rejects.toThrow('synthetic-record-failure');
  expect(fake.identities.size).toBe(1);
  expect(fake.queries.some(sql => /^DROP DATABASE/.test(sql))).toBe(false);
});

it('refuses unsafe retained mode and missing identity recorder before constructing a client', async () => {
  await expect(openBackupTimestampFixture({ ...safe, RAILWAY_PROJECT_ID: 'synthetic-marker' }, { retainOwned: true, onIntent: async () => {}, onOwned: async () => {} })).rejects.toThrow();
  await expect(openBackupTimestampFixture(safe, { retainOwned: true, onOwned: async () => {} })).rejects.toThrow();
  await expect(openBackupTimestampFixture(safe, { retainOwned: true, onIntent: async () => {} })).rejects.toThrow();
  expect(fake.clients).toBe(0);
});

it('keeps the prior identity-checked cleanup outside retain-only mode', async () => {
  const fixture = await openBackupTimestampFixture(safe);
  await fixture.close();
  expect(fake.queries.filter(sql => /^DROP DATABASE/.test(sql))).toHaveLength(3);
});

it('records an intent before CREATE and keeps prior intent when identity recording fails', async () => {
  const events: string[] = [];
  await expect(openBackupTimestampFixture(safe, { retainOwned: true,
    onIntent: async name => { expect(fake.identities.has(name)).toBe(false); events.push('intent'); },
    onOwned: async identity => { expect(fake.identities.has(identity.name)).toBe(true); events.push('identity'); throw new Error('synthetic-record-failure'); },
  })).rejects.toThrow('synthetic-record-failure');
  expect(events).toEqual(['intent', 'identity']);
  expect(fake.queries.some(sql => /^DROP DATABASE/.test(sql))).toBe(false);
  expect(fake.identities.size).toBe(1);
  expect(fake.closedClients).toBe(1);
});

it('does not create a database when intent recording fails', async () => {
  await expect(openBackupTimestampFixture(safe, { retainOwned: true,
    onIntent: async () => { throw new Error('synthetic-intent-failure'); }, onOwned: async () => {},
  })).rejects.toThrow('synthetic-intent-failure');
  expect(fake.identities.size).toBe(0);
  expect(fake.queries.some(sql => /^DROP DATABASE/.test(sql))).toBe(false);
  expect(fake.closedClients).toBe(1);
});

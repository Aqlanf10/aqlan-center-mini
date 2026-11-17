import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { validatedRestoreFullTarget } from '../scripts/security/restore-full-target-guard.mjs';
import { restoreClientConfigFor, createRestoreClientSnapshot, restoreConfigFromSnapshot } from '../lib/restore/client-config';
import { parseRestoreIdentity } from '../lib/restore/target-identity.mjs';
import { AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID, AQLAN_CENTER_MINI_DATABASE_NAME } from '../lib/database-scope';
import { snapshotRestoreEnvironment } from '../lib/restore/target-scope';

const REMOTE = 'pg-staging.example.invalid';
const REMOTE_INPUT =
  'postgresql://synthetic:synthetic@' + REMOTE +
  ':5432/aqlan_recovery_synthetic?sslmode=verify-full';
// Synthetic certificate fixture: no network call, no private key, no patient data.
// This verifies the *actual pg.Client configuration*. Handshake to a real CA
// is a separate end-to-end staging test, not claimed by this test.
const CA = '-----BEGIN CERTIFICATE-----\nSYNTHETIC-NO-NETWORK-CA\n-----END CERTIFICATE-----';
type ObservedPgClient = {
  connectionParameters: {
    host: string;
    database: string;
    port: number | string;
    user: string;
    ssl: false | {
      rejectUnauthorized?: boolean;
      ca?: string[] | string | Buffer;
      servername?: string;
      checkServerIdentity?: unknown;
    };
  };
};
function actualConnectionParameters(client: Client): ObservedPgClient['connectionParameters'] {
  // @types/pg intentionally hides this runtime property. Read-only inspection
  // of the *constructed* pg client is required to catch SSL URL precedence.
  return (client as unknown as ObservedPgClient).connectionParameters;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('restore:full effective node-postgres TLS configuration (without connect)', () => {
  it('preserves CA, rejects unauthorized peer, and pins hostname in actual pg.Client', () => {
    const target = validatedRestoreFullTarget(REMOTE_INPUT, {
      NODE_ENV: 'test',
      DATABASE_ENVIRONMENT: 'staging',
      PGSSL_ROOT_CERT_PEM: CA,
    });
    // An sslmode parameter in node-postgres may replace the explicit ssl object.
    // It is validated as input but MUST NOT reach pg.Client's connection string.
    expect(new URL(target.connectionString).search).toBe('');

    vi.stubEnv('PGSSL_ROOT_CERT_PEM', CA);
    vi.stubEnv('PGSSL_ROOT_CERT', undefined);
    const config = restoreClientConfigFor(target.connectionString);
    const actualClient = new Client(config); // DO NOT invoke .connect()

    const effective = actualConnectionParameters(actualClient);
    expect(effective.host).toBe(REMOTE);
    expect(effective.database).toBe('aqlan_recovery_synthetic');
    expect(effective.ssl).toBeTruthy();
    expect(typeof effective.ssl).toBe('object');
    if (!effective.ssl || typeof effective.ssl !== 'object') {
      throw new Error('Actual pg.Client SSL is not a verified TLS options object');
    }
    expect(effective.ssl.rejectUnauthorized).toBe(true);
    expect(effective.ssl.ca).toEqual([CA.trim() + '\n']);
    expect(effective.ssl.servername).toBe(REMOTE);
    // No bypass of Node TLS default certificate host identity checking.
    expect(effective.ssl.checkServerIdentity).toBeUndefined();
  });

  it('fails closed on remote TLS with no CA instead of allowing unverified encryption', () => {
    vi.stubEnv('PGSSL_ROOT_CERT_PEM', undefined);
    vi.stubEnv('PGSSL_ROOT_CERT', undefined);
    const target = validatedRestoreFullTarget(REMOTE_INPUT, {
      NODE_ENV: 'test',
      DATABASE_ENVIRONMENT: 'staging',
      PGSSL_ROOT_CERT_PEM: CA,
    });
    // Simulates runtime CA removal after input policy validation.
    expect(() => restoreClientConfigFor(target.connectionString))
      .toThrow(/RESTORE_TLS_VERIFICATION_REQUIRED/);
  });

  it('rejects a remote sslmode query at the actual pg configuration boundary', () => {
    vi.stubEnv('PGSSL_ROOT_CERT_PEM', CA);
    expect(() => restoreClientConfigFor(REMOTE_INPUT))
      .toThrow(/RESTORE_TLS_UNSAFE_QUERY/);
  });

  it('keeps SSL off only for explicit literal-loopback synthetic test target', () => {
    const local = validatedRestoreFullTarget(
      'postgresql://fixture:fixture@127.0.0.1:5432/aqlan_test_synthetic?sslmode=disable',
      { NODE_ENV:'test', DATABASE_ENVIRONMENT:'test' },
    );
    const actualClient = new Client(restoreClientConfigFor(local.connectionString));
    expect(actualConnectionParameters(actualClient).host).toBe('127.0.0.1');
    expect(actualConnectionParameters(actualClient).ssl).toBe(false);
  });
});


describe('restore target identity has no parser overrides or inherited defaults', () => {
  it('does not retain alias credentials, CA content or unrelated environment in the scoped snapshot', () => {
    const env=snapshotRestoreEnvironment({DATABASE_URL:'postgresql://user:synthetic-secret@localhost:5432/db?sslmode=disable',
      PGSSL_ROOT_CERT_PEM:'synthetic-certificate', UNRELATED_SECRET:'synthetic-unrelated'});
    const saved=JSON.stringify(env);
    expect(saved).not.toContain('synthetic-secret'); expect(saved).not.toContain('synthetic-certificate');
    expect(saved).not.toContain('synthetic-unrelated');
    const identity=parseRestoreIdentity(env.DATABASE_URL!);
    expect(identity.host).toBe('localhost'); expect(identity.port).toBe('5432'); expect(identity.database).toBe('db');
    expect(env.PGSSL_ROOT_CERT_PEM).toBe('configured');
  });
  it.each([
    'postgresql://synthetic:synthetic@127.0.0.1:5432/db',
    'postgresql://synthetic%40user:synthetic@127.0.0.1:5433/db_name',
    'postgresql://synthetic:synthetic@localhost:5432/db?sslmode=disable',
    'postgresql://synthetic@127.0.0.1:5432/db',
  ])('matches the pg Client effective identity without opening a socket', value => {
    const expected=parseRestoreIdentity(value,{target:true});
    const effective=actualConnectionParameters(new Client(restoreClientConfigFor(value)));
    expect(effective.host).toBe(expected.host);
    expect(String(effective.port)).toBe(expected.port);
    expect(effective.user).toBe(expected.user);
    expect(effective.database).toBe(expected.database);
  });
  it.each([
    'postgresql://synthetic:synthetic@127.0.0.1:5432/db?host=remote.invalid',
    'postgresql://synthetic:synthetic@127.0.0.1:5432/db?%68ost=remote.invalid',
    'postgresql://synthetic:synthetic@127.0.0.1:5432/db?port=9999',
    'postgresql://synthetic:synthetic@127.0.0.1/db',
    'postgresql://synthetic:synthetic@127.0.0.1:5432/',
    'postgresql://127.0.0.1:5432/db',
    'postgresql://synthetic:synthetic@%2Ftmp:5432/db',
    'postgresql://synthetic%00:synthetic@127.0.0.1:5432/db',
    'postgresql://synthetic:synthetic%0d%0a@127.0.0.1:5432/db',
  ])('refuses a noncanonical target before constructing pg', value => {
    expect(() => restoreClientConfigFor(value)).toThrow();
  });
  it.each(['PGHOST','PGPORT','PGDATABASE','PGUSER','PGOPTIONS','PGSSLMODE'])('refuses inherited %s', key => {
    vi.stubEnv(key,'synthetic-override');
    expect(() => restoreClientConfigFor('postgresql://synthetic:synthetic@127.0.0.1:5432/db')).toThrow('RESTORE_TARGET_AMBIENT_PG_OPTION');
  });
  it('rejects forged or redirected snapshots and freezes validated configuration', () => {
    const snapshot=createRestoreClientSnapshot('postgresql://synthetic:synthetic@127.0.0.1:5432/db');
    expect(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.config)).toBe(true);
    expect(() => restoreConfigFromSnapshot({...snapshot},snapshot.targetUrl)).toThrow('RESTORE_TARGET_SNAPSHOT_INVALID');
    expect(() => restoreConfigFromSnapshot(snapshot,'postgresql://synthetic:synthetic@127.0.0.1:5432/other')).toThrow('RESTORE_TARGET_SNAPSHOT_INVALID');
  });
  it('rechecks aliases before each use of an issued snapshot', () => {
    const snapshot=createRestoreClientSnapshot('postgresql://synthetic:synthetic@127.0.0.1:5432/db');
    vi.stubEnv('POSTGRES_URL','postgresql://different:synthetic@localhost:5432/db');
    expect(() => restoreConfigFromSnapshot(snapshot,snapshot.targetUrl)).toThrow('RESTORE_TARGET_COLLISION');
  });
  it('rechecks the application scoped database after the project identity changes', () => {
    vi.stubEnv('DATABASE_URL','postgresql://source:synthetic@127.0.0.1:5432/railway');
    const snapshot=createRestoreClientSnapshot(`postgresql://synthetic:synthetic@127.0.0.1:5432/${AQLAN_CENTER_MINI_DATABASE_NAME}`);
    vi.stubEnv('RAILWAY_PROJECT_ID',AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID);
    expect(() => restoreConfigFromSnapshot(snapshot,snapshot.targetUrl)).toThrow('RESTORE_TARGET_COLLISION');
  });
  it('rejects a wrong project before a snapshot can be used', () => {
    const snapshot=createRestoreClientSnapshot('postgresql://synthetic:synthetic@127.0.0.1:5432/db');
    vi.stubEnv('RAILWAY_PROJECT_ID','synthetic-wrong-project');
    expect(() => restoreConfigFromSnapshot(snapshot,snapshot.targetUrl)).toThrow('RESTORE_TARGET_SCOPE_INVALID');
  });
  it('does not accept an unverified TLS decision for a loopback alias spelling', () => {
    vi.stubEnv('PGSSL_ROOT_CERT_PEM', undefined); vi.stubEnv('PGSSL_ROOT_CERT', undefined);
    expect(() => restoreClientConfigFor('postgresql://synthetic:synthetic@localhost.:5432/db')).toThrow('RESTORE_TLS_VERIFICATION_REQUIRED');
  });
  it('pins the actual local client endpoint and forbids remote TLS downgrade with ?host', () => {
    const config=restoreClientConfigFor('postgresql://synthetic:synthetic@127.0.0.1:5432/db?sslmode=disable');
    const actual=new Client(config); const effective=actualConnectionParameters(actual);
    expect(effective.host).toBe('127.0.0.1'); expect(effective.database).toBe('db'); expect(effective.ssl).toBe(false);
    expect(() => restoreClientConfigFor('postgresql://synthetic:synthetic@127.0.0.1:5432/db?host=remote.invalid')).toThrow();
  });
});

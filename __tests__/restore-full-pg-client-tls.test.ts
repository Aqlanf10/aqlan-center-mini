import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { validatedRestoreFullTarget } from '../scripts/security/restore-full-target-guard.mjs';
import { restoreClientConfigFor } from '../lib/restore/client-config';

const REMOTE = 'pg-staging.example.invalid';
const REMOTE_INPUT =
  'postgresql://synthetic:synthetic@' + REMOTE +
  ':5432/aqlan_recovery_synthetic?sslmode=verify-full';
// Synthetic certificate fixture: no network call, no private key, no patient data.
// This verifies the *actual pg.Client configuration*. Handshake to a real CA
// is a separate end-to-end staging test, not claimed by this test.
const CA = '-----BEGIN CERTIFICATE-----\nSYNTHETIC-NO-NETWORK-CA\n-----END CERTIFICATE-----';

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

    const effective = actualClient.connectionParameters;
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

  it('keeps SSL off only for explicit literal-loopback synthetic test target', () => {
    const local = validatedRestoreFullTarget(
      'postgresql://fixture:fixture@127.0.0.1:5432/aqlan_test_synthetic?sslmode=disable',
      { NODE_ENV:'test', DATABASE_ENVIRONMENT:'test' },
    );
    const actualClient = new Client(restoreClientConfigFor(local.connectionString));
    expect(actualClient.connectionParameters.host).toBe('127.0.0.1');
    expect(actualClient.connectionParameters.ssl).toBe(false);
  });
});

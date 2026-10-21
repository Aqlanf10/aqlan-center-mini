import type { ClientConfig } from 'pg';
import { sslForConnection } from '../db-tls';

/**
 * The configuration sent to the ACTUAL pg.Client by stagedRestore.
 * A PG connection-string sslmode query can replace the ssl object passed here.
 * restore:full therefore passes a validated canonical URL with no sslmode
 * for remote staging, keeping the CA and server identity verification intact.
 */
export function restoreClientConfigFor(url: string): ClientConfig {
  const parsed = new URL(url);
  const hostname = parsed.hostname;
  const localHost = hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost';

  // A connection-string SSL query may replace an explicitly supplied
  // verified TLS object during pg.Client construction. Never permit such a
  // query for a remote restore, even when called outside the restore:full CLI.
  if (!localHost && [...parsed.searchParams].some(([key]) =>
    ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey'].includes(key.toLowerCase())
  )) {
    throw new Error('RESTORE_TLS_UNSAFE_QUERY: remote SSL options must not override verified TLS configuration.');
  }

  const ssl = sslForConnection(url);
  // Unlike ordinary read-only connections, a medical-record restore must
  // never accept encrypted-but-unverified remote TLS.
  if (!localHost) {
    if (ssl === false || ssl.rejectUnauthorized !== true ||
        !ssl.ca || (Array.isArray(ssl.ca) && ssl.ca.length === 0)) {
      throw new Error('RESTORE_TLS_VERIFICATION_REQUIRED: a trusted CA is mandatory for remote restores.');
    }
    // Explicit SNI and server identity target. Leave checkServerIdentity
    // unset so Node TLS performs its standard hostname verification.
    return { connectionString: url, ssl: { ...ssl, servername: hostname } };
  }
  return { connectionString: url, ssl };
}

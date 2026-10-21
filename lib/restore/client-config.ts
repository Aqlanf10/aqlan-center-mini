import type { ClientConfig } from 'pg';
import { sslForConnection } from '../db-tls';

/**
 * The configuration sent to the ACTUAL pg.Client by stagedRestore.
 * A PG connection-string sslmode query can replace the ssl object passed here.
 * restore:full therefore passes a validated canonical URL with no sslmode
 * for remote staging, keeping the CA and server identity verification intact.
 */
export function restoreClientConfigFor(url: string): ClientConfig {
  const ssl = sslForConnection(url);
  if (ssl !== false && ssl.rejectUnauthorized === true) {
    const hostname = new URL(url).hostname;
    // Explicit SNI and hostname check target. No custom checkServerIdentity:
    // Node's default hostname identity verification remains enabled.
    return { connectionString: url, ssl: { ...ssl, servername: hostname } };
  }
  return { connectionString: url, ssl };
}

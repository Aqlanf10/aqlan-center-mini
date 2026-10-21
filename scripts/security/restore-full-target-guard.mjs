import { RAILWAY_ENV_NAMES, validateVerificationQueryParameters, isLoopbackHost } from '../../lib/verification-target-policy.mjs';

/**
 * Strict effective target guard for restore:full before loading archive or pg.
 * Local synthetic restore is supported; remote destinations require explicitly
 * declared staging and independently configured PEM TLS verification.
 */
export function validatedRestoreFullTarget(raw, env = process.env) {
  const deny = (reason) => { throw new Error('RESTORE_FULL_UNSAFE_TARGET: ' + reason); };
  if (typeof raw !== 'string' || !raw.trim() || raw !== raw.trim() ||
      [...raw].some(ch => ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127)) {
    deny('ambiguous or missing PostgreSQL URL');
  }
  if (env.NODE_ENV === 'production' || env.DATABASE_ENVIRONMENT?.trim().toLowerCase() === 'production') {
    deny('production runtime or target declaration');
  }
  for (const name of RAILWAY_ENV_NAMES) if (env[name]?.trim()) deny('Railway runtime marker present: ' + name);
  const unsupportedPgEnv = [
    'PGHOST', 'PGHOSTADDR', 'PGDATABASE', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE',
    'PGOPTIONS', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY',
    'PGSSLCRL', 'PGPASSFILE', 'PGSSL_ROOT_CERT',
  ];
  for (const name of unsupportedPgEnv) if (env[name] !== undefined) deny('ambient PostgreSQL option: ' + name);
  let url;
  try { url = new URL(raw); } catch { deny('invalid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash ||
      !url.username || !url.pathname.startsWith('/') || !url.pathname.slice(1)) {
    deny('explicit PostgreSQL user/database required; fragments disallowed');
  }
  let name;
  try { name = decodeURIComponent(url.pathname.slice(1)); } catch { deny('invalid database encoding'); }
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/.test(name) || url.pathname.slice(1) !== name) {
    deny('noncanonical or ambiguous database name');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === '[::1]';
  // Reuse canonical query validator for local synthetic PG18.
  if (loopback) {
    try { validateVerificationQueryParameters(url); }
    catch { deny('query overrides or TLS options are disallowed for local restore'); }
    if (!['test', 'development', 'staging', undefined].includes(env.DATABASE_ENVIRONMENT?.trim().toLowerCase())) {
      deny('unknown local database declaration');
    }
  } else {
    if (isLoopbackHost(host) || !/^[A-Za-z0-9.-]+$/.test(host)) {
      deny('ambiguous target host');
    }
    if (env.DATABASE_ENVIRONMENT?.trim().toLowerCase() !== 'staging') {
      deny('remote restore requires explicit staging declaration');
    }
    if ([...url.searchParams].length !== 1 ||
        url.searchParams.get('sslmode') !== 'verify-full' ||
        [...url.searchParams][0][0] !== 'sslmode') {
      deny('remote staging requires only sslmode=verify-full');
    }
    if (!env.PGSSL_ROOT_CERT_PEM?.trim() ||
        !env.PGSSL_ROOT_CERT_PEM.trim().startsWith('-----BEGIN CERTIFICATE-----')) {
      deny('remote staging requires verified TLS CA PEM');
    }
  }
  // Explicitly reject pg-connection-string query host/database/service
  // overrides and certificate file parameters, including encoded keys.
  const clean = new URL(url.toString());
  clean.search = '';
  clean.hash = '';
  clean.pathname = '/' + name;
  // Do not forward sslmode=verify-full to node-postgres: pg-connection-string
  // may replace the explicitly supplied { ca, rejectUnauthorized, servername }
  // object when an sslmode query option is present. The guard has already
  // required verify-full in the INPUT for remote staging; the actual TLS
  // verification is enforced in restoreClientConfigFor, not URL query parsing.
  if (loopback) clean.searchParams.set('sslmode', 'disable');
  return { connectionString: clean.toString(), host, database: name, local: loopback };
}

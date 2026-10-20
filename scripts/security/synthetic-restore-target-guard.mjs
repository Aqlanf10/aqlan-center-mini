import { validateLocalVerificationTarget, validateOperationalVerificationEnvironment } from '../../lib/verification-target-policy.mjs';

/**
 * Strict pre-I/O gate for the legacy SQL importer.
 * PostgreSQL URI query parameters can override URL authority/path. Reject
 * unknown options and pass the client a sanitized URL, not the original URL.
 * This importer is confined to disposable local backup_dst_* fixtures.
 */
const refusal = (reason) => { throw new Error('Legacy restore refused: ' + reason); };

export function assertSafeLegacyRestoreTarget(connectionString, env = process.env) {
  if (typeof connectionString !== 'string' || connectionString !== connectionString.trim() || [...connectionString].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) {
    refusal('ambiguous whitespace or control character in target URI');
  }
  try { validateOperationalVerificationEnvironment(env); }
  catch { refusal('conflicting operational database URL or runtime environment'); }
  if (env.NODE_ENV === 'production' ||
      env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID || env.RAILWAY_ENVIRONMENT ||
      env.RAILWAY_ENVIRONMENT_NAME) {
    refusal('production or Railway runtime is forbidden');
  }
  const declared = env.DATABASE_ENVIRONMENT?.trim().toLowerCase();
  if (declared && declared !== 'test' && declared !== 'development') {
    refusal('target declaration is not test/development');
  }
  // Deny implicit destination and TLS-file fallbacks before Client construction.
  const unsafeEnvironmentKeys = [
    'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE',
    'PGOPTIONS', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY',
    'PGSSLCRL', 'PGPASSFILE', 'PGSSL_ROOT_CERT', 'PGSSL_ROOT_CERT_PEM',
  ];
  for (const name of unsafeEnvironmentKeys) {
    if (env[name] !== undefined) refusal('ambiguous PostgreSQL environment option ' + name);
  }
  // Share the repository's existing #185 safe-target URI policy rather than
  // silently diverge from its URL override, encoding and Railway checks.
  let url;
  try { url = validateLocalVerificationTarget(connectionString, env, { varName:'DATABASE_URL' }); }
  catch { refusal('canonical verification target policy rejected this URI'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) {
    refusal('unsupported scheme or URI fragment');
  }
  if (!url.username || !url.pathname.startsWith('/') || !url.pathname.slice(1)) {
    refusal('explicit user and database are required');
  }
  // Even encoded query keys and repeated parameters are rejected.
  // sslmode=disable is the only permitted option for loopback fixtures.
  let seenSslmode = false;
  for (const [name, value] of url.searchParams) {
    if (name !== 'sslmode' || value !== 'disable' || seenSslmode) {
      refusal('unsupported or duplicate PostgreSQL URI option: ' + name.slice(0, 50));
    }
    seenSslmode = true;
  }
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', '[::1]'].includes(host)) {
    refusal('only literal IP loopback hosts are allowed');
  }
  let database;
  try { database = decodeURIComponent(url.pathname.slice(1)); }
  catch { refusal('invalid database encoding'); }
  const isLegacyDrill = /^backup_dst_[a-z0-9_]{6,80}$/.test(database);
  // Existing restore-multiline-literals.test.ts uses a random dedicated
  // aqlan_backup_precision_* database owned by its fixture helper.
  const isOwnedPrecisionFixture = /^aqlan_backup_precision_[a-f0-9]{32}$/.test(database)
    && env.NODE_ENV === 'test';
  if (!isLegacyDrill && !isOwnedPrecisionFixture) {
    refusal('database must be a dedicated synthetic restore fixture');
  }
  if (url.pathname.slice(1).includes('%') || url.pathname.slice(1) !== database) {
    refusal('encoded database names are ambiguous');
  }
  // Reconstitute from validated values: do not pass unchecked options to pg.
  const canonical = new URL(url.toString());
  canonical.search = '';
  canonical.hash = '';
  canonical.pathname = '/' + database;
  canonical.searchParams.set('sslmode', 'disable');
  return { host, database, connectionString: canonical.toString() };
}

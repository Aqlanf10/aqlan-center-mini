/** Fail closed before the legacy SQL importer opens a database connection. */
export function assertSafeLegacyRestoreTarget(connectionString, env = process.env) {
  if (env.DATABASE_ENVIRONMENT?.trim().toLowerCase() === 'production' ||
      env.NODE_ENV === 'production' || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID ||
      env.RAILWAY_ENVIRONMENT_NAME) {
    throw new Error('Legacy restore refused: production runtime or target declaration.');
  }
  let parsed;
  try { parsed = new URL(connectionString); }
  catch { throw new Error('Legacy restore refused: invalid target URL.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Legacy restore refused: unsupported target protocol.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('Legacy restore refused: only explicitly isolated local PostgreSQL targets are accepted.');
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^backup_dst_[a-z0-9_]{6,80}$/.test(database)) {
    throw new Error('Legacy restore refused: target must be a dedicated synthetic backup_dst_ database. Use restore:full for a controlled real recovery.');
  }
  if (env.DATABASE_ENVIRONMENT && !['test', 'development'].includes(env.DATABASE_ENVIRONMENT.trim().toLowerCase())) {
    throw new Error('Legacy restore refused: target environment is not test/development.');
  }
  return { host, database };
}

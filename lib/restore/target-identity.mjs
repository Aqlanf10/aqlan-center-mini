import { parse } from 'pg-connection-string';
import { RUNTIME_DATABASE_URL_ENV_NAMES } from '../verification-target-policy.mjs';

// The two application-owned CA variables are deliberate TLS configuration,
// not libpq target overrides. All other PG* values are refused, even blank.
export function assertNoAmbientPgOptions(...environments) {
  for (const env of environments) for (const key of Object.keys(env)) {
    if (/^PG[A-Z0-9_]*$/.test(key) && key !== 'PGSSL_ROOT_CERT' && key !== 'PGSSL_ROOT_CERT_PEM' && env[key] !== undefined)
      throw new Error('RESTORE_TARGET_AMBIENT_PG_OPTION');
  }
}
function hostKey(host) {
  const lower = host.toLowerCase().replace(/\.$/, '');
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(lower) ? 'loopback' : lower;
}
/** Reject ambiguous/default/override spellings before invoking the pg parser. */
export function parseRestoreIdentity(raw, { target = false } = {}) {
  if (typeof raw !== 'string' || !raw || raw !== raw.trim() || /[\x00-\x20\x7f]/.test(raw)) throw new Error('RESTORE_TARGET_INVALID');
  let url;
  try { url = new URL(raw); } catch { throw new Error('RESTORE_TARGET_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || !url.hostname || /[%\\]/.test(url.hostname) || !url.port || !url.username
      || !url.pathname.startsWith('/') || !/^[A-Za-z0-9_.-]+$/.test(url.pathname.slice(1))) throw new Error('RESTORE_TARGET_INVALID');
  const query = [...url.searchParams];
  if (query.length > 1 || query.some(([key,value]) => key !== 'sslmode' || !['disable','require','verify-ca','verify-full'].includes(value)))
    throw new Error('RESTORE_TARGET_UNSAFE_QUERY');
  const local = hostKey(url.hostname) === 'loopback';
  if (target && query.length && (!local || query[0][1] !== 'disable'))
    throw new Error(local ? 'RESTORE_TARGET_UNSAFE_QUERY' : 'RESTORE_TLS_UNSAFE_QUERY');
  const clean = new URL(url.toString()); clean.search = ''; clean.hash = '';
  let parsed;
  try { parsed = parse(clean.toString()); } catch { throw new Error('RESTORE_TARGET_INVALID'); }
  if (!parsed.host || parsed.host.toLowerCase() !== clean.hostname.toLowerCase() || !parsed.port || !parsed.user || !parsed.database
      || parsed.database !== clean.pathname.slice(1)
      || /[\x00-\x1f\x7f]/.test(parsed.user) || (parsed.password && /[\x00-\x1f\x7f]/.test(parsed.password))) throw new Error('RESTORE_TARGET_INVALID');
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RESTORE_TARGET_INVALID');
  return { connectionString: clean.toString(), host: parsed.host, port: String(port), database: parsed.database,
    user: parsed.user, hostKey: hostKey(parsed.host), local };
}
export function assertNoRuntimeTargetCollision(identity, ...environments) {
  for (const env of environments) for (const key of RUNTIME_DATABASE_URL_ENV_NAMES) {
    if (!env[key]) continue;
    const other = parseRestoreIdentity(env[key]);
    if (identity.hostKey === other.hostKey && identity.port === other.port && identity.database === other.database)
      throw new Error('RESTORE_TARGET_COLLISION');
  }
}

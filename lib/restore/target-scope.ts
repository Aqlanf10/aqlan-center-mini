import { assertCorrectDatabaseProject, databaseUrlForProject } from '../database-scope';
import { RUNTIME_DATABASE_URL_ENV_NAMES } from '../verification-target-policy.mjs';
import { assertNoRuntimeTargetCollision, parseRestoreIdentity, type RestoreIdentity } from './target-identity.mjs';

type Environment = Record<string, string | undefined>;

/** Retain only fields relevant to collision checks; never snapshot all secrets. */
export function snapshotRestoreEnvironment(environment: Environment): Readonly<Environment> {
  const snapshot: Environment = { RAILWAY_PROJECT_ID: environment.RAILWAY_PROJECT_ID };
  for (const key of RUNTIME_DATABASE_URL_ENV_NAMES) {
    const value=environment[key];
    if (!value) { snapshot[key]=value; continue; }
    // Validate the original before discarding credentials and TLS parameters.
    // Project scoping changes only the database and TLS query parameters; only
    // host, port and database are used for a collision decision.
    const identity=parseRestoreIdentity(value);
    const url=new URL(identity.connectionString);
    url.username='restore-scope'; url.password='';
    snapshot[key]=url.toString();
  }
  for (const [key,value] of Object.entries(environment)) {
    if (/^PG[A-Z0-9_]*$/.test(key) && value !== undefined) snapshot[key]=value.trim() ? 'configured' : '';
  }
  return Object.freeze(snapshot);
}

/** Compare raw and application-scoped aliases without exposing their values. */
export function assertNoScopedRestoreCollision(identity: RestoreIdentity, ...environments: Environment[]): void {
  try {
    for (const environment of environments) assertCorrectDatabaseProject(environment);
  } catch {
    throw new Error('RESTORE_TARGET_SCOPE_INVALID');
  }
  // Check the raw forms first so a scope transform cannot hide URL overrides.
  assertNoRuntimeTargetCollision(identity, ...environments);
  // A caller-supplied alias and the real process project scope can come from
  // different snapshots. Check each combination conservatively.
  for (const aliases of environments) for (const scope of environments) {
    for (const key of RUNTIME_DATABASE_URL_ENV_NAMES) {
      const value=aliases[key];
      if (!value) continue;
      let scoped: string;
      try { scoped=databaseUrlForProject(value, scope); }
      catch { throw new Error('RESTORE_TARGET_SCOPE_INVALID'); }
      assertNoRuntimeTargetCollision(identity, { [key]: scoped });
    }
  }
}

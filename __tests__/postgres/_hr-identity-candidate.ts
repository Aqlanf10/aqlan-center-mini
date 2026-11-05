import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MigrationFile } from '../../lib/migration-files';

/** Deliberately nonnumeric: exercises the real migrator without reserving a
 * production version or placing an executable file in migrations/. */
export function identityCandidate(): MigrationFile {
  const sql = readFileSync(new URL('../../docs/proposals/hr-person-identity.sql', import.meta.url), 'utf8');
  return { version: 'test-hr-identity-candidate', name: 'synthetic_identity_candidate',
    filename: 'docs/proposals/hr-person-identity.sql', sql,
    checksum: createHash('sha256').update(sql).digest('hex') };
}

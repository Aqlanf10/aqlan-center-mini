import { loadMigrationFiles, type MigrationFile } from '../migration-files';

// Only catalogues loaded here from the local migration source may cross the
// admin precheck/reset boundary. Freeze both the array and each file so a
// caller cannot substitute source SQL or provenance after precheck.
const trusted = new WeakSet<object>();

export async function createRestoreMigrationSnapshot(): Promise<MigrationFile[]> {
  const files = await loadMigrationFiles();
  const snapshot = files.map(file => Object.freeze({ ...file }));
  Object.freeze(snapshot);
  trusted.add(snapshot);
  return snapshot;
}

export function isRestoreMigrationSnapshot(value: unknown): value is MigrationFile[] {
  return typeof value === 'object' && value !== null && trusted.has(value);
}
